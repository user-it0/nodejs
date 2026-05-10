import express from 'express';
import { spawn } from 'child_process';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { attachExecutionRequestAuthHeaders, isLikelyOracleControlPlaneUrl } from './lib/execution-auth.js';
import {
  dispatchGitHubExecutionRun,
  getGitHubExecutionConfig,
  isGitHubExecutionConfigured
} from './lib/github-actions.js';

const app = express();
const { Client: PgClient } = pg;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const MAX_CODE_BYTES = Number(process.env.HELPER_MAX_CODE_BYTES || 200000);
const SERVICE_NAME = String(process.env.SERVICE_NAME || 'ivucx-railway-helper').trim() || 'ivucx-railway-helper';
const SERVICE_VERSION = String(process.env.SERVICE_VERSION || '1.8.1').trim() || '1.8.1';

const HELPER_API_KEY = String(process.env.HELPER_API_KEY || '').trim();
const EXECUTION_SERVER_BASE_URL = String(process.env.EXECUTION_SERVER_BASE_URL || '').trim().replace(/\/+$/, '');
const EXECUTION_SERVER_API_KEY = String(process.env.EXECUTION_SERVER_API_KEY || '').trim();
const EXECUTION_SERVER_TIMEOUT_MS = Number(process.env.EXECUTION_SERVER_TIMEOUT_MS || 180000);
const EXECUTION_SERVER_CONVERT_ROUTE = String(process.env.EXECUTION_SERVER_CONVERT_ROUTE || '/api/proof-convert').trim();
const EXECUTION_SERVER_LEAN_CHECK_ROUTE = String(process.env.EXECUTION_SERVER_LEAN_CHECK_ROUTE || '/api/lean-check').trim();
const EXECUTION_SERVER_COQ_CHECK_ROUTE = String(process.env.EXECUTION_SERVER_COQ_CHECK_ROUTE || '/api/coq-check').trim();
const EXECUTION_BASE_URL_HEADER = 'x-ivucx-execution-base-url';
const HELPER_PUBLIC_BASE_URL = String(process.env.HELPER_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const GITHUB_ACTIONS_CALLBACK_ROUTE = '/api/helper/github-actions/callback';
const GITHUB_ACTIONS_PLAN_EXECUTION_ROUTE_PATTERN = /^\/api\/helper\/plans\/[^/]+\/execution$/;
const GITHUB_EXECUTION_SYNC_WAIT_TIMEOUT_MS = Number(process.env.GITHUB_EXECUTION_SYNC_WAIT_TIMEOUT_MS || 45000);
const GITHUB_EXECUTION_SYNC_WAIT_POLL_MS = Number(process.env.GITHUB_EXECUTION_SYNC_WAIT_POLL_MS || 1500);
const HELPER_LOCAL_PROOF_CHECK_ENABLED = parseBoolean(
  process.env.HELPER_LOCAL_PROOF_CHECK_ENABLED || process.env.LOCAL_PROOF_CHECK_ENABLED,
  true
);
const HELPER_LOCAL_PROOF_CHECK_LANGUAGES = String(
  process.env.HELPER_LOCAL_PROOF_CHECK_LANGUAGES || 'coq'
)
  .split(',')
  .map((language) => language.trim().toLowerCase())
  .filter(Boolean);
const LOCAL_PROOF_CHECK_TIMEOUT_MS = Number(process.env.LOCAL_PROOF_CHECK_TIMEOUT_MS || 20000);
const HELPER_DISK_STATE_FALLBACK = !['0', 'false', 'no', 'off'].includes(
  String(process.env.HELPER_DISK_STATE_FALLBACK || 'true').trim().toLowerCase()
);
const HELPER_STATE_DIR = resolvePath(
  String(process.env.HELPER_STATE_DIR || join(MODULE_DIR, '.run', 'state')).trim()
);
const HELPER_ALLOWED_ORIGINS = String(
  process.env.HELPER_ALLOWED_ORIGINS
  || 'https://provf.onrender.com,http://localhost:3000,http://127.0.0.1:3000'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const HELPER_AUTO_SCHEMA_BOOTSTRAP = !['0', 'false', 'no', 'off'].includes(
  String(process.env.HELPER_AUTO_SCHEMA_BOOTSTRAP || 'true').trim().toLowerCase()
);
const HELPER_SCHEMA_SQL_PATH = String(process.env.HELPER_SCHEMA_SQL_PATH || '').trim();
const HELPER_SCHEMA_SQL_CANDIDATES = Object.freeze([
  './supabase/proof_helper.sql',
  '../supabase/proof_helper.sql',
  '../../supabase/proof_helper.sql'
]);

const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed'
};

const PLAN_STATUS = {
  QUEUED: 'queued',
  PLANNING: 'planning',
  READY: 'ready',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed'
};

const REQUIRED_SUPABASE_TABLES = Object.freeze([
  'helper_jobs',
  'helper_conversion_plans',
  'problems'
]);

const REQUIRED_SUPABASE_COLUMNS = Object.freeze({
  helper_jobs: ['id', 'status', 'operation', 'progress', 'plan_id'],
  helper_conversion_plans: ['id', 'helper_job_id', 'operation', 'execution_payload', 'request_meta'],
  problems: [
    'id',
    'title',
    'language',
    'file_name',
    'source_code',
    'source_sha256',
    'proof_state',
    'verification_status',
    'verification_result',
    'normalized_format',
    'normalized_term',
    'adapter_name',
    'adapter_meta',
    'helper_job_id',
    'request_meta'
  ]
});

const ENABLE_MEMORY_SCHEMA_FALLBACK = !['0', 'false', 'no', 'off'].includes(
  String(process.env.HELPER_MEMORY_SCHEMA_FALLBACK || 'true').trim().toLowerCase()
);

const jobs = new Map();
const plans = new Map();
let supabaseClient = null;
let supabaseSchemaBootstrapPromise = null;
let supabaseSchemaSqlCache = null;
let supabaseSchemaBootstrapState = {
  attempted: false,
  ok: false,
  lastReason: '',
  lastAppliedAt: '',
  lastError: ''
};

function stateFileName(id) {
  return `${String(id || '').replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;
}

function stateFilePath(kind, id) {
  return join(HELPER_STATE_DIR, kind, stateFileName(id));
}

async function writeDiskState(kind, id, value) {
  if (!HELPER_DISK_STATE_FALLBACK || !id) return;
  const dir = join(HELPER_STATE_DIR, kind);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(stateFilePath(kind, id), JSON.stringify(value, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  });
}

async function readDiskState(kind, id) {
  if (!HELPER_DISK_STATE_FALLBACK || !id) return null;
  try {
    const raw = await readFile(stateFilePath(kind, id), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
  const allowAll = HELPER_ALLOWED_ORIGINS.includes('*');
  const allowOrigin = allowAll || (origin && HELPER_ALLOWED_ORIGINS.includes(origin));

  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Ivucx-Execution-Base-Url');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});

app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    routes: [
      '/healthz',
      '/api/helper/info',
      '/api/helper/schema-check',
      '/api/lean-check',
      '/api/coq-check',
      '/api/proof-convert'
    ]
  });
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    supabaseConfigured: !!getSupabaseAdmin().client,
    execution: getExecutionInfo(),
    roles: getRoleInfo()
  });
});

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const executionToken = String(req.headers['x-ivucx-execution-token'] || '').trim();
  const isGitHubExecutionBridgeRoute = (
    (req.method === 'POST' && req.path === GITHUB_ACTIONS_CALLBACK_ROUTE)
    || (req.method === 'GET' && GITHUB_ACTIONS_PLAN_EXECUTION_ROUTE_PATTERN.test(req.path))
  );
  if (isGitHubExecutionBridgeRoute && executionToken) {
    req.ivucxAuthMode = 'execution-token';
    next();
    return;
  }
  if (!HELPER_API_KEY) {
    next();
    return;
  }
  const auth = String(req.headers.authorization || '');
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) {
    res.status(401).json({ ok: false, error: 'Missing helper authorization.' });
    return;
  }
  const received = Buffer.from(auth.slice(prefix.length));
  const expected = Buffer.from(HELPER_API_KEY);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.status(403).json({ ok: false, error: 'Invalid helper authorization.' });
    return;
  }
  req.ivucxAuthMode = 'helper-api-key';
  next();
});

app.get('/api/helper/info', (_req, res) => {
  const supabase = getSupabaseAdmin();
  const supabaseEnv = resolveSupabaseEnv();
  const executionInfo = getExecutionInfo(_req);
  const executionConfigured = !!executionInfo.configured;
  const executionBackend = getExecutionBackendType(executionInfo);
  const typedLambdaAvailability = buildConversionAvailability(_req, 'typed-lambda');
  const cicAvailability = buildConversionAvailability(_req, 'cic');
  res.status(200).json({
    ok: true,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    supabaseConfigured: !!supabase.client,
    supabaseEnv: {
      urlConfigured: !!supabaseEnv.url,
      serviceRoleConfigured: !!supabaseEnv.serviceRoleKey,
      anonConfigured: !!supabaseEnv.anonKey
    },
    executionConfigured,
    roles: getRoleInfo(),
    capabilities: {
      proofCheck: true,
      convert: true,
      submit: !!supabase.client || ENABLE_MEMORY_SCHEMA_FALLBACK,
      cicConvert: Boolean(cicAvailability.lean.available || cicAvailability.coq.available),
      planState: true,
      schemaCheck: true,
      executionBridge: true,
      memorySchemaFallback: ENABLE_MEMORY_SCHEMA_FALLBACK,
      diskStateFallback: HELPER_DISK_STATE_FALLBACK,
      asyncJobs: true
    },
    routes: [
      'GET /api/helper/info',
      'GET /api/helper/schema-check',
      'POST /api/lean-check',
      'POST /api/coq-check',
      'POST /api/proof-convert',
      'POST /api/helper/check',
      'POST /api/helper/submit',
      'POST /api/helper/convert',
      'GET /api/helper/plans/:id/execution',
      'POST /api/helper/github-actions/callback',
      'GET /api/helper/jobs',
      'GET /api/helper/jobs/:id',
      'GET /api/helper/jobs/:id/result',
      'DELETE /api/helper/jobs/:id'
    ],
    runtimes: {
      executionModel: {
        stateStore: supabase.client
          ? (ENABLE_MEMORY_SCHEMA_FALLBACK ? 'supabase-with-memory-fallback' : 'supabase')
          : (HELPER_DISK_STATE_FALLBACK ? 'disk-memory' : 'memory'),
        planning: 'railway',
        proofCheck: executionConfigured ? executionBackend : 'unconfigured',
        conversion: executionConfigured ? executionBackend : 'unconfigured'
      },
      conversionRuntimes: {
        typedLambda: typedLambdaAvailability,
        cic: cicAvailability
      }
    },
    execution: executionInfo,
    githubExecution: getGitHubExecutionConfig()
  });
});

app.get('/api/helper/schema-check', async (_req, res) => {
  try {
    const schema = await inspectSupabaseSchema();
    res.status(schema.ok ? 200 : 503).json({
      ok: schema.ok,
      schema
    });
  } catch (err) {
    res.status(err && err.statusCode ? err.statusCode : 500).json({
      ok: false,
      error: err && err.message ? err.message : String(err),
      details: err && err.details ? err.details : null
    });
  }
});

app.post('/api/lean-check', async (req, res) => {
  await handleCompatibilityProofCheck(req, res, 'Lean');
});

app.post('/api/coq-check', async (req, res) => {
  await handleCompatibilityProofCheck(req, res, 'Coq');
});

app.post('/api/proof-convert', async (req, res) => {
  await handleCompatibilityProofConvert(req, res);
});

app.post('/api/helper/check', async (req, res) => {
  try {
    const payload = normalizeProofPayload(req.body || {});
    const wantsAsync = req.body && req.body.async !== false;
    const localVerification = await tryLocalProofCheck(payload);

    if (localVerification) {
      res.status(statusCodeForVerification(localVerification)).json({
        ok: Boolean(localVerification.ok),
        verification: localVerification
      });
      return;
    }

    if (isGitHubExecutionConfigured()) {
      if (wantsAsync) {
        const job = await createPlannedJob(payload, 'check', req);
        await dispatchPlannedJob(job.id);
        const dispatched = await getJob(job.id);
        res.status(202).json({ ok: true, job: publicJob(dispatched || job) });
        return;
      }

      const job = await createPlannedJob(payload, 'check', req);
      await dispatchPlannedJob(job.id);
      const finalJob = await waitForJobTerminalState(job.id);
      if (!finalJob) {
        res.status(504).json({
          ok: false,
          error: 'GitHub Actions proof check did not finish within the sync wait timeout.',
          job: publicJob(job)
        });
        return;
      }

      const verification = finalJob.result && finalJob.result.verification
        ? finalJob.result.verification
        : {
          ok: false,
          timedOut: false,
          error: finalJob.error && finalJob.error.message
            ? finalJob.error.message
            : 'GitHub Actions proof check failed.',
          source: 'github-actions',
          proofState: normalizeProofState(analyzeProofState(payload.language, payload.code).proofState) || 'NN'
        };
      res.status(statusCodeForVerification(verification)).json({ ok: Boolean(verification.ok), verification });
      return;
    }

    const verification = await requestExecutionCheck(payload, req);
    res.status(statusCodeForVerification(verification)).json({ ok: verification.ok, verification });
  } catch (err) {
    res.status(err && err.statusCode ? err.statusCode : 400).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.post('/api/helper/submit', async (req, res) => {
  await handlePlannedRequest(req, res, 'submit');
});

app.post('/api/helper/convert', async (req, res) => {
  await handlePlannedRequest(req, res, 'convert');
});

app.get('/api/helper/plans/:id/execution', async (req, res) => {
  try {
    const plan = await requirePlan(req.params.id);
    assertGitHubExecutionBridgeAccess(plan, req);
    res.status(200).json({
      ok: true,
      plan: toGitHubExecutionPlanPayload(plan)
    });
  } catch (err) {
    res.status(err && err.statusCode ? err.statusCode : 400).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.post(GITHUB_ACTIONS_CALLBACK_ROUTE, async (req, res) => {
  try {
    await handleGitHubActionsCallback(req.body || {}, req);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(err && err.statusCode ? err.statusCode : 400).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/helper/jobs', async (_req, res) => {
  try {
    const list = await listJobs();
    res.status(200).json({ ok: true, jobs: list.map(publicJob) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

app.get('/api/helper/jobs/:id/result', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  if (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.RUNNING) {
    res.status(409).json({ ok: false, error: 'Helper job is not finished yet.', job: publicJob(job) });
    return;
  }
  res.status(200).json({
    ok: job.status === JOB_STATUS.SUCCEEDED,
    status: job.status,
    result: job.result || null,
    error: job.status === JOB_STATUS.FAILED ? (job.error || null) : null,
    job: publicJob(job)
  });
});

app.get('/api/helper/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  res.status(200).json({ ok: true, job: publicJob(job) });
});

app.delete('/api/helper/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  jobs.delete(job.id);
  const { client } = getSupabaseAdmin();
  if (client) {
    const { error } = await client.from('helper_jobs').delete().eq('id', job.id);
    if (error && !shouldFallbackForMissingTable(error, 'helper_jobs')) {
      if (isMissingSupabaseRelationError(error, 'helper_jobs')) {
        res.status(503).json({
          ok: false,
          error: createMissingSupabaseTableError('helper_jobs', error).message
        });
        return;
      }
      res.status(502).json({
        ok: false,
        error: error.message || 'Failed to delete helper job row.'
      });
      return;
    }
  }
  res.status(200).json({ ok: true, removed: true, jobId: job.id });
});

startServer().catch((err) => {
  console.error('Failed to start ivucx railway helper', err);
  process.exit(1);
});

function getRoleInfo() {
  const executionInfo = getExecutionInfo();
  return {
    stateStore: 'supabase',
    planner: 'railway',
    executor: getExecutionBackendType(executionInfo)
  };
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }

  switch (String(value).trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallbackValue;
  }
}

function hasConfiguredEnv(...names) {
  return names.some((name) => String(process.env[name] || '').trim());
}

function isLeanCicConfigured(executionInfo) {
  const backend = getExecutionBackendType(executionInfo);
  if (!executionInfo.configured) {
    return false;
  }

  if (backend === 'github-actions') {
    return parseBoolean(
      process.env.GITHUB_EXECUTION_ENABLE_LEAN_CIC
      || process.env.IVUCX_ENABLE_LEAN_CIC
      || process.env.LEAN_CIC_ENABLED,
      hasConfiguredEnv(
        'IVUCX_LEAN_EXPORTER_BIN',
        'LEAN4EXPORT_BIN',
        'IVUCX_LEAN_EXPORTER_CMD',
        'LEAN4EXPORT_CMD'
      )
    );
  }

  if (backend === 'execution-server') {
    return parseBoolean(
      process.env.EXECUTION_SERVER_ENABLE_LEAN_CIC
      || process.env.IVUCX_ENABLE_LEAN_CIC
      || process.env.LEAN_CIC_ENABLED,
      false
    );
  }

  return false;
}

function isCoqCicConfigured(executionInfo) {
  const backend = getExecutionBackendType(executionInfo);
  if (!executionInfo.configured) {
    return false;
  }

  if (backend === 'github-actions') {
    return parseBoolean(
      process.env.GITHUB_EXECUTION_ENABLE_COQ_CIC
      || process.env.IVUCX_ENABLE_COQ_CIC
      || process.env.COQ_CIC_ENABLED,
      hasConfiguredEnv(
        'IVUCX_COQ_CIC_EXPORT_CMD',
        'COQ_CIC_EXPORT_CMD'
      )
    );
  }

  if (backend === 'execution-server') {
    return parseBoolean(
      process.env.EXECUTION_SERVER_ENABLE_COQ_CIC
      || process.env.IVUCX_ENABLE_COQ_CIC
      || process.env.COQ_CIC_ENABLED,
      false
    );
  }

  return false;
}

function buildConversionAvailability(req, family = 'typed-lambda') {
  const executionInfo = getExecutionInfo(req);
  const backend = getExecutionBackendType(executionInfo);
  const typedLambdaAvailable = !!executionInfo.configured;
  const leanAvailable = family === 'cic'
    ? (typedLambdaAvailable && isLeanCicConfigured(executionInfo))
    : typedLambdaAvailable;
  const coqAvailable = family === 'cic'
    ? (typedLambdaAvailable && isCoqCicConfigured(executionInfo))
    : typedLambdaAvailable;
  return {
    lean: {
      available: leanAvailable,
      planner: 'railway',
      executor: executionInfo.configured ? backend : 'unconfigured',
      stateStore: 'supabase'
    },
    coq: {
      available: coqAvailable,
      planner: 'railway',
      executor: executionInfo.configured ? backend : 'unconfigured',
      stateStore: 'supabase'
    }
  };
}

function firstNonEmptyHeaderValue(value) {
  if (Array.isArray(value)) {
    return firstNonEmptyHeaderValue(value[0]);
  }
  if (typeof value !== 'string') {
    return '';
  }
  return value.split(',')[0].trim();
}

function normalizeRemoteBaseUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.replace(/\/+$/, '');
}

function inferPublicBaseUrlFromRequest(req) {
  const forwardedProto = firstNonEmptyHeaderValue(req?.headers?.['x-forwarded-proto']);
  const forwardedHost = firstNonEmptyHeaderValue(req?.headers?.['x-forwarded-host']);
  const host = forwardedHost || firstNonEmptyHeaderValue(req?.headers?.host);
  if (!host) {
    return '';
  }

  const protocol = forwardedProto || 'https';
  return normalizeRemoteBaseUrl(`${protocol}://${host}`);
}

function resolveExecutionBaseUrlFromRequest(req) {
  const forwarded = req && req.headers
    ? (
      req.headers[EXECUTION_BASE_URL_HEADER]
      || req.headers[EXECUTION_BASE_URL_HEADER.toLowerCase()]
    )
    : '';
  return normalizeRemoteBaseUrl(firstNonEmptyHeaderValue(forwarded) || EXECUTION_SERVER_BASE_URL);
}

function resolveExecutionBaseUrlFromPlan(plan) {
  return normalizeRemoteBaseUrl(
    plan?.executionPayload?.executionBaseUrl
    || plan?.plan?.execution?.baseUrl
    || plan?.requestMeta?.executionBaseUrl
    || EXECUTION_SERVER_BASE_URL
  );
}

function resolveHelperPublicBaseUrl(reqOrPlan = null) {
  if (HELPER_PUBLIC_BASE_URL) {
    return HELPER_PUBLIC_BASE_URL;
  }

  if (reqOrPlan && reqOrPlan.headers) {
    return inferPublicBaseUrlFromRequest(reqOrPlan);
  }

  return normalizeRemoteBaseUrl(
    reqOrPlan?.requestMeta?.helperBaseUrl
    || reqOrPlan?.executionPayload?.helperBaseUrl
    || ''
  );
}

function getExecutionBackendType(executionInfo = null) {
  if (isGitHubExecutionConfigured()) {
    return 'github-actions';
  }

  if (executionInfo && executionInfo.configured && executionInfo.baseUrl) {
    return 'execution-server';
  }

  return 'unconfigured';
}

function getExecutionInfo(reqOrPlan = null) {
  const baseUrl = reqOrPlan && reqOrPlan.headers
    ? resolveExecutionBaseUrlFromRequest(reqOrPlan)
    : resolveExecutionBaseUrlFromPlan(reqOrPlan);
  const github = getGitHubExecutionConfig();
  const githubConfigured = isGitHubExecutionConfigured();
  const helperBaseUrl = resolveHelperPublicBaseUrl(reqOrPlan);
  const configured = githubConfigured || !!baseUrl;
  const backend = githubConfigured ? 'github-actions' : (baseUrl ? 'execution-server' : 'unconfigured');
  const warning = isLikelyOracleControlPlaneUrl(baseUrl)
    ? 'Configured execution URL looks like the Oracle Cloud control-plane endpoint, not the Oracle-server app URL.'
    : (
      githubConfigured && !helperBaseUrl
        ? 'GitHub Actions execution is enabled, but HELPER_PUBLIC_BASE_URL could not be resolved for workflow callbacks.'
        : null
    );
  return {
    configured,
    backend,
    baseUrl: baseUrl || null,
    source: githubConfigured
      ? 'github-actions'
      : (
        baseUrl
      ? (normalizeRemoteBaseUrl(EXECUTION_SERVER_BASE_URL) === baseUrl ? 'helper-env' : 'request-bridge')
          : 'unconfigured'
      ),
    convertRoute: EXECUTION_SERVER_CONVERT_ROUTE,
    leanCheckRoute: EXECUTION_SERVER_LEAN_CHECK_ROUTE,
    coqCheckRoute: EXECUTION_SERVER_COQ_CHECK_ROUTE,
    timeoutMs: EXECUTION_SERVER_TIMEOUT_MS,
    helperBaseUrl: helperBaseUrl || null,
    github,
    warning
  };
}

function extractSupabaseErrorMessage(error) {
  if (!error || typeof error !== 'object') {
    return '';
  }
  return String(error.message || error.details || error.hint || '').trim();
}

function isMissingSupabaseRelationError(error, relationName) {
  const message = extractSupabaseErrorMessage(error).toLowerCase();
  const relation = String(relationName || '').trim().toLowerCase();
  return (
    error?.code === 'PGRST205'
    || error?.code === '42P01'
    || (relation && message.includes(`could not find the table 'public.${relation}' in the schema cache`))
    || (relation && message.includes(`relation "public.${relation}" does not exist`))
    || (relation && message.includes(`relation "${relation}" does not exist`))
  );
}

function extractMissingSupabaseColumn(error, relationName) {
  const message = extractSupabaseErrorMessage(error);
  if (!message) {
    return null;
  }

  const match = message.match(/Could not find the '([^']+)' column of '([^']+)' in the schema cache/i);
  if (!match) {
    return null;
  }

  const columnName = String(match[1] || '').trim();
  const targetRelation = String(match[2] || '').trim().toLowerCase();
  const relation = String(relationName || '').trim().toLowerCase();
  if (!columnName || !relation || targetRelation !== relation) {
    return null;
  }

  return columnName;
}

function createMissingSupabaseTableError(tableName, error) {
  const bootstrapHint = HELPER_AUTO_SCHEMA_BOOTSTRAP && !resolveSupabaseDbUrl()
    ? ' Set SUPABASE_DB_URL (or DATABASE_URL / POSTGRES_URL) to let the helper create it automatically.'
    : '';
  const missing = new Error(
    `Supabase table public.${tableName} is missing in the connected project. Apply supabase/proof_helper.sql to the same project referenced by NEXT_PUBLIC_SUPABASE_URL.${bootstrapHint}`
  );
  missing.statusCode = 503;
  missing.details = {
    table: tableName,
    supabaseMessage: extractSupabaseErrorMessage(error) || null
  };
  return missing;
}

function createMissingSupabaseColumnError(tableName, columnName, error) {
  const bootstrapHint = HELPER_AUTO_SCHEMA_BOOTSTRAP && !resolveSupabaseDbUrl()
    ? ' Set SUPABASE_DB_URL (or DATABASE_URL / POSTGRES_URL) to let the helper migrate it automatically.'
    : '';
  const missing = new Error(
    `Supabase column public.${tableName}.${columnName} is missing in the connected project. Apply supabase/proof_helper.sql again so the existing table is migrated.${bootstrapHint}`
  );
  missing.statusCode = 503;
  missing.details = {
    table: tableName,
    column: columnName,
    supabaseMessage: extractSupabaseErrorMessage(error) || null
  };
  return missing;
}

function shouldFallbackForMissingTable(error, tableName) {
  return ENABLE_MEMORY_SCHEMA_FALLBACK && isMissingSupabaseRelationError(error, tableName);
}

function firstNonEmpty(values) {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function resolveSupabaseEnv() {
  const url = firstNonEmpty([
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.PUBLIC_SUPABASE_URL,
    process.env.VITE_SUPABASE_URL
  ]);
  const serviceRoleKey = firstNonEmpty([
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    process.env.SUPABASE_SERVICE_KEY,
    process.env.SUPABASE_SERVICE_ROLE,
    process.env.SUPABASE_SECRET_KEY
  ]);
  const anonKey = firstNonEmpty([
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.VITE_SUPABASE_ANON_KEY
  ]);

  return {
    url,
    serviceRoleKey,
    anonKey
  };
}

function resolveSupabaseDbUrl() {
  return firstNonEmpty([
    process.env.SUPABASE_DB_URL,
    process.env.SUPABASE_DATABASE_URL,
    process.env.SUPABASE_DB_DIRECT_URL,
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.POSTGRES_PRISMA_URL
  ]);
}

function resolveSchemaSqlCandidatePath(candidatePath) {
  if (!candidatePath) {
    return '';
  }
  return isAbsolute(candidatePath)
    ? candidatePath
    : resolvePath(MODULE_DIR, candidatePath);
}

async function loadHelperSchemaSql() {
  if (supabaseSchemaSqlCache) {
    return supabaseSchemaSqlCache;
  }

  const candidates = [
    HELPER_SCHEMA_SQL_PATH,
    ...HELPER_SCHEMA_SQL_CANDIDATES
  ]
    .map((candidate) => resolveSchemaSqlCandidatePath(candidate))
    .filter(Boolean);

  let lastError = null;
  for (const candidate of candidates) {
    try {
      const sql = await readFile(candidate, 'utf8');
      const normalized = String(sql || '').trim();
      if (normalized) {
        supabaseSchemaSqlCache = normalized;
        return normalized;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    lastError && lastError.message
      ? `Unable to load proof helper schema SQL. ${lastError.message}`
      : 'Unable to load proof helper schema SQL.'
  );
}

async function ensureSupabaseSchema(reason = 'runtime') {
  if (!HELPER_AUTO_SCHEMA_BOOTSTRAP) {
    return {
      ok: false,
      attempted: false,
      skipped: 'disabled',
      reason
    };
  }

  if (supabaseSchemaBootstrapPromise) {
    return supabaseSchemaBootstrapPromise;
  }

  supabaseSchemaBootstrapPromise = (async () => {
    const connectionString = resolveSupabaseDbUrl();
    if (!connectionString) {
      const result = {
        ok: false,
        attempted: false,
        skipped: 'missing-db-url',
        reason,
        error: 'No Supabase Postgres connection string is configured for automatic schema bootstrap.'
      };
      supabaseSchemaBootstrapState = {
        attempted: true,
        ok: false,
        lastReason: reason,
        lastAppliedAt: supabaseSchemaBootstrapState.lastAppliedAt,
        lastError: result.error
      };
      return result;
    }

    const sql = await loadHelperSchemaSql();
    const client = new PgClient({
      connectionString,
      ssl: /\bsslmode=disable\b/i.test(connectionString)
        ? undefined
        : { rejectUnauthorized: false }
    });

    try {
      await client.connect();
      await client.query(sql);
      const appliedAt = nowIso();
      const result = {
        ok: true,
        attempted: true,
        reason,
        appliedAt
      };
      supabaseSchemaBootstrapState = {
        attempted: true,
        ok: true,
        lastReason: reason,
        lastAppliedAt: appliedAt,
        lastError: ''
      };
      return result;
    } catch (error) {
      const result = {
        ok: false,
        attempted: true,
        reason,
        error: error && error.message ? error.message : String(error)
      };
      supabaseSchemaBootstrapState = {
        attempted: true,
        ok: false,
        lastReason: reason,
        lastAppliedAt: supabaseSchemaBootstrapState.lastAppliedAt,
        lastError: result.error
      };
      return result;
    } finally {
      try {
        await client.end();
      } catch (error) {
        // ignore connection shutdown noise
      }
    }
  })().finally(() => {
    supabaseSchemaBootstrapPromise = null;
  });

  return supabaseSchemaBootstrapPromise;
}

function getSupabaseAdmin() {
  const { url, serviceRoleKey, anonKey } = resolveSupabaseEnv();
  if (!url || !serviceRoleKey) {
    const missing = [];
    if (!url) {
      missing.push('NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)');
    }
    if (!serviceRoleKey) {
      missing.push('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)');
    }

    const anonNote = anonKey
      ? ' A public anon key is present, but helper planning still requires a server-side service-role key.'
      : ' BlueMode UI may expose only public values; the helper still requires a server-side service-role key.';

    return {
      client: null,
      error: `Supabase environment variables are missing. Set ${missing.join(' and ')}.${anonNote}`
    };
  }
  if (!supabaseClient) {
    supabaseClient = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return { client: supabaseClient, error: null };
}

async function inspectSupabaseSchema() {
  const { client, error } = getSupabaseAdmin();
  if (!client) {
    return {
      ok: false,
      configured: false,
      error: error || 'Supabase is not configured.',
      tables: {},
      bootstrap: { ...supabaseSchemaBootstrapState }
    };
  }

  const tables = {};
  let ok = true;

  for (const tableName of REQUIRED_SUPABASE_TABLES) {
    const requiredColumns = REQUIRED_SUPABASE_COLUMNS[tableName] || ['id'];
    const { error: tableError } = await client
      .from(tableName)
      .select(requiredColumns.join(','), { head: true, count: 'exact' })
      .limit(1);

    if (tableError) {
      ok = false;
      const missingColumn = extractMissingSupabaseColumn(tableError, tableName);
      tables[tableName] = {
        present: false,
        error: extractSupabaseErrorMessage(tableError) || 'Unknown schema error',
        missingColumn: missingColumn || null
      };
      continue;
    }

    tables[tableName] = {
      present: true,
      error: null,
      missingColumn: null
    };
  }

  return {
    ok,
    configured: true,
    tables,
    bootstrap: { ...supabaseSchemaBootstrapState }
  };
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function truncateOutput(text, limit = 12000) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `\n...[output truncated ${value.length - limit} chars]`;
}

function splitCommandArgs(rawValue) {
  return String(rawValue || '')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function shouldUseLocalProofCheck(language) {
  if (!HELPER_LOCAL_PROOF_CHECK_ENABLED) {
    return false;
  }
  const normalized = String(language || '').trim().toLowerCase();
  return HELPER_LOCAL_PROOF_CHECK_LANGUAGES.includes(normalized);
}

function getLocalProofRuntime(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized === 'coq') {
    return {
      command: String(process.env.COQ_CMD || 'coqc').trim(),
      args: splitCommandArgs(process.env.COQ_ARGS || ''),
      extension: '.v',
      defaultFileName: 'Main.v'
    };
  }

  return {
    command: String(process.env.LEAN_CMD || 'lean').trim(),
    args: splitCommandArgs(process.env.LEAN_ARGS || ''),
    extension: '.lean',
    defaultFileName: 'Main.lean'
  };
}

function sanitizeProofFileName(fileName, fallbackFileName, extension) {
  const rawName = basename(String(fileName || fallbackFileName || 'Main').trim() || fallbackFileName);
  if (rawName.toLowerCase().endsWith(extension)) {
    return rawName;
  }
  const withoutExtension = rawName.replace(/\.[^.]*$/, '') || 'Main';
  return `${withoutExtension}${extension}`;
}

function commandMissing(error) {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return error && error.code === 'ENOENT' || message.includes('enoent') || message.includes('not found');
}

async function runLocalProofCheck(payload) {
  const runtime = getLocalProofRuntime(payload.language);
  if (!runtime.command) {
    const error = new Error('Local proof command is not configured.');
    error.statusCode = 503;
    throw error;
  }

  const normalizedCode = typeof payload.code === 'string' ? payload.code : '';
  const tempDir = await mkdtemp(join(tmpdir(), `ivucx-proof-${payload.language.toLowerCase()}-`));
  const fileName = sanitizeProofFileName(payload.fileName, runtime.defaultFileName, runtime.extension);
  const filePath = join(tempDir, fileName);
  const startedAt = Date.now();

  await writeFile(filePath, normalizedCode, 'utf8');

  try {
    const execution = await new Promise((resolve, reject) => {
      const child = spawn(runtime.command, [...runtime.args, filePath], {
        cwd: tempDir,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, LOCAL_PROOF_CHECK_TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });

      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({
          ok: exitCode === 0 && !timedOut,
          exitCode,
          signal,
          timedOut,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt
        });
      });
    });

    return {
      ok: execution.ok,
      language: payload.language.toLowerCase(),
      fileName,
      command: runtime.command,
      args: runtime.args.concat([fileName]),
      exitCode: typeof execution.exitCode === 'number' ? execution.exitCode : null,
      signal: execution.signal || null,
      timedOut: Boolean(execution.timedOut),
      durationMs: execution.durationMs,
      codeBytes: Buffer.byteLength(normalizedCode, 'utf8'),
      stdout: truncateOutput(execution.stdout),
      stderr: truncateOutput(execution.stderr),
      error: execution.ok ? '' : truncateOutput(execution.stderr || execution.stdout || 'Local proof check failed.'),
      upstreamStatus: execution.timedOut ? 504 : (execution.ok ? 200 : 422),
      source: 'gce-local-proof-check',
      proofState: normalizeProofState(analyzeProofState(payload.language, payload.code).proofState) || 'NN'
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function tryLocalProofCheck(payload) {
  if (!shouldUseLocalProofCheck(payload.language)) {
    return null;
  }

  try {
    return await runLocalProofCheck(payload);
  } catch (error) {
    if (commandMissing(error)) {
      return null;
    }
    throw error;
  }
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    return null;
  }
}
function normalizeProofPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const language = resolveLanguage(body.language);
  if (language !== 'Lean' && language !== 'Coq') {
    throw new Error('Only Lean and Coq are supported by the helper service.');
  }
  const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim() : defaultFileName(language);
  const code = typeof body.code === 'string' ? body.code : '';
  const format = typeof body.format === 'string' && body.format.trim() ? body.format.trim() : 'typed-lambda-v1';
  const verify = body.verify !== false;

  if (!code.trim()) {
    throw new Error('Proof code is required.');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new Error('Proof code exceeds helper size limit.');
  }

  return { title, language, fileName, code, format, verify };
}

function resolveLanguage(value) {
  const input = String(value || '').trim().toLowerCase();
  if (input === 'coq') return 'Coq';
  return 'Lean';
}

function defaultFileName(language) {
  return language === 'Coq' ? 'Main.v' : 'Main.lean';
}

function normalizeProofState(value) {
  const proofState = String(value || '').trim().toUpperCase();
  return /^(YY|NY|YN|NN)$/.test(proofState) ? proofState : '';
}

function createProgress(percent, stage, message) {
  return {
    percent: Math.max(0, Math.min(100, Number(percent) || 0)),
    stage: String(stage || '').trim() || 'working',
    message: String(message || '').trim() || 'Working',
    updatedAt: nowIso()
  };
}

function safeSecretEquals(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && leftBuffer.length > 0 && timingSafeEqual(leftBuffer, rightBuffer);
}

function getGitHubExecutionAccessToken(plan) {
  return String(plan?.requestMeta?.githubActions?.executionToken || '').trim();
}

function toGitHubExecutionPlanPayload(plan) {
  return {
    id: plan.id,
    helperJobId: plan.helperJobId || null,
    operation: plan.operation || 'convert',
    title: plan.title || '',
    language: plan.language || 'Lean',
    fileName: plan.fileName || defaultFileName(plan.language || 'Lean'),
    requestedFormat: plan.requestedFormat || 'typed-lambda-v1',
    verify: plan.verify !== false,
    sourceCode: plan.sourceCode || '',
    sourceSha256: plan.sourceSha256 || sha256(plan.sourceCode || '')
  };
}

function assertGitHubExecutionBridgeAccess(plan, req) {
  const authMode = String(req?.ivucxAuthMode || '').trim();
  if (authMode === 'helper-api-key') {
    return;
  }

  const expectedToken = getGitHubExecutionAccessToken(plan);
  const receivedToken = String(req?.headers?.['x-ivucx-execution-token'] || '').trim();
  if (authMode === 'execution-token' && safeSecretEquals(receivedToken, expectedToken)) {
    return;
  }

  const error = new Error('Invalid GitHub Actions execution token.');
  error.statusCode = 403;
  throw error;
}

async function revokeGitHubExecutionAccessToken(plan) {
  const currentToken = getGitHubExecutionAccessToken(plan);
  if (!currentToken) {
    return;
  }
  plan.requestMeta = {
    ...(plan.requestMeta || {}),
    githubActions: {
      ...((plan.requestMeta && plan.requestMeta.githubActions) || {}),
      executionToken: null,
      consumedAt: nowIso()
    }
  };
  await persistPlan(plan);
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    operation: job.operation || 'convert',
    title: job.title,
    language: job.language,
    fileName: job.fileName,
    format: job.format,
    planId: job.planId || null,
    progress: job.progress || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.result || null,
    error: job.status === JOB_STATUS.FAILED ? job.error : null,
    problemId: job.problemId || null
  };
}

function defaultRequestedFormat(operation, payload) {
  const requested = typeof payload?.format === 'string' ? payload.format.trim() : '';
  if (requested) {
    return requested;
  }
  return String(operation || '').trim().toLowerCase() === 'check' ? 'proof-check-v1' : 'typed-lambda-v1';
}

async function handlePlannedRequest(req, res, operation) {
  try {
    const payload = normalizeProofPayload(req.body || {});
    const wantsAsync = req.body && req.body.async !== false;

    if (isGitHubExecutionConfigured()) {
      if (!wantsAsync) {
        const job = await createPlannedJob(payload, operation, req);
        await dispatchPlannedJob(job.id);
        const finalJob = await waitForJobTerminalState(job.id);
        if (!finalJob) {
          res.status(504).json({
            ok: false,
            error: 'GitHub Actions conversion did not finish within the sync wait timeout.',
            job: publicJob(job)
          });
          return;
        }

        const finalResult = finalJob.result || buildGitHubExecutionFailureResult(finalJob, payload, operation);
        res.status(statusCodeForResult(finalResult)).json({ ok: Boolean(finalResult.ok), result: finalResult });
        return;
      }

      const job = await createPlannedJob(payload, operation, req);
      await dispatchPlannedJob(job.id);
      const dispatched = await getJob(job.id);
      res.status(202).json({ ok: true, job: publicJob(dispatched || job) });
      return;
    }

    if (!wantsAsync) {
      const plan = await createConversionPlan(payload, operation, null, req);
      const result = await executePlannedOperation(plan, null);
      res.status(statusCodeForResult(result)).json({ ok: Boolean(result.ok), result });
      return;
    }

    const job = await createPlannedJob(payload, operation, req);
    await dispatchPlannedJob(job.id);
    const dispatched = await getJob(job.id);
    res.status(202).json({ ok: true, job: publicJob(dispatched || job) });
  } catch (err) {
    res.status(err && err.statusCode ? err.statusCode : 400).json({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function handleCompatibilityProofCheck(req, res, language) {
  try {
    const payload = normalizeProofPayload({
      ...(req.body || {}),
      language
    });
    const localVerification = await tryLocalProofCheck(payload);

    if (localVerification) {
      const legacy = toLegacyProofCheckBody(localVerification);
      res.status(statusCodeForVerification(localVerification)).json(legacy);
      return;
    }

    if (isGitHubExecutionConfigured()) {
      const job = await createPlannedJob(payload, 'check', req);
      await dispatchPlannedJob(job.id);
      const finalJob = await waitForJobTerminalState(job.id);

      if (!finalJob) {
        res.status(504).json({
          ok: false,
          status: 'timeout',
          error: 'GitHub Actions proof check did not finish within the sync wait timeout.',
          job: publicJob(job)
        });
        return;
      }

      const verification = finalJob.result && finalJob.result.verification
        ? finalJob.result.verification
        : {
          ok: false,
          timedOut: false,
          error: finalJob.error && finalJob.error.message
            ? finalJob.error.message
            : 'GitHub Actions proof check failed.',
          source: 'github-actions',
          proofState: normalizeProofState(analyzeProofState(payload.language, payload.code).proofState) || 'NN'
        };
      const legacy = toLegacyProofCheckBody(verification);
      res.status(statusCodeForVerification(verification)).json(legacy);
      return;
    }

    ensureExternalExecutionProxyTarget(req);
    const upstream = await sendExecutionRequest(
      language === 'Coq' ? EXECUTION_SERVER_COQ_CHECK_ROUTE : EXECUTION_SERVER_LEAN_CHECK_ROUTE,
      {
        code: payload.code,
        fileName: payload.fileName
      },
      getExecutionInfo(req).baseUrl
    );
    forwardExecutionResponse(res, upstream);
  } catch (err) {
    const statusCode = err && err.statusCode ? err.statusCode : 400;
    res.status(statusCode).json({
      ok: false,
      status: statusCode === 504 ? 'timeout' : 'error',
      error: err && err.message ? err.message : String(err)
    });
  }
}

async function handleCompatibilityProofConvert(req, res) {
  try {
    if (isGitHubExecutionConfigured()) {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const payload = await normalizeCompatibilityConvertPayload(body);
      const job = payload.planId && !payload.code
        ? await createJobForExistingPlan(await requirePlan(payload.planId), req, 'convert')
        : await createPlannedJob(payload, 'convert', req);

      await dispatchPlannedJob(job.id);
      const finalJob = await waitForJobTerminalState(job.id);

      if (!finalJob) {
        res.status(504).json({
          success: false,
          error: 'GitHub Actions conversion did not finish within the sync wait timeout.',
          job: publicJob(job)
        });
        return;
      }

      const finalResult = finalJob.result || buildGitHubExecutionFailureResult(finalJob, payload, 'convert');
      res.status(statusCodeForResult(finalResult)).json({
        success: Boolean(finalResult.ok),
        result: finalResult
      });
      return;
    }

    ensureExternalExecutionProxyTarget(req);
    const upstream = await sendExecutionRequest(
      EXECUTION_SERVER_CONVERT_ROUTE,
      req.body || {},
      getExecutionInfo(req).baseUrl
    );
    forwardExecutionResponse(res, upstream);
  } catch (err) {
    const statusCode = err && err.statusCode ? err.statusCode : 400;
    res.status(statusCode).json({
      success: false,
      error: err && err.message ? err.message : String(err),
      details: err && err.details ? err.details : null
    });
  }
}

async function createPlannedJob(payload, operation, req) {
  const requestedFormat = defaultRequestedFormat(operation, payload);
  const job = {
    id: randomUUID(),
    status: JOB_STATUS.QUEUED,
    operation,
    title: payload.title,
    language: payload.language,
    fileName: payload.fileName,
    format: requestedFormat,
    sourceSha256: sha256(payload.code),
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    progress: createProgress(10, 'planning', 'Planning'),
    result: null,
    error: null,
    problemId: null,
    planId: null
  };
  const plan = await createConversionPlan(payload, operation, job.id, req);
  job.planId = plan.id;
  await persistJob(job);
  jobs.set(job.id, job);
  return job;
}

async function createJobForExistingPlan(plan, req, operation = 'convert') {
  const job = {
    id: randomUUID(),
    status: JOB_STATUS.QUEUED,
    operation: operation || plan.operation || 'convert',
    title: plan.title || '',
    language: plan.language || 'Lean',
    fileName: plan.fileName || defaultFileName(plan.language || 'Lean'),
    format: plan.requestedFormat || 'typed-lambda-v1',
    sourceSha256: plan.sourceSha256 || sha256(plan.sourceCode || ''),
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    progress: createProgress(10, 'planning', 'Planning'),
    result: null,
    error: null,
    problemId: null,
    planId: plan.id
  };

  await persistJob(job);
  jobs.set(job.id, job);
  return job;
}

async function createConversionPlan(payload, operation, helperJobId, req) {
  const { client } = getSupabaseAdmin();
  const sourceBytes = Buffer.byteLength(payload.code, 'utf8');
  const sourceSha256 = sha256(payload.code);
  const closure = analyzeProofState(payload.language, payload.code);
  const createdAt = nowIso();
  const executionInfo = getExecutionInfo(req);
  const executionBackend = getExecutionBackendType(executionInfo);
  const requestedFormat = defaultRequestedFormat(operation, payload);
  const githubExecutionToken = randomUUID();

  const plan = {
    id: randomUUID(),
    helperJobId,
    operation,
    status: PLAN_STATUS.QUEUED,
    title: payload.title || '',
    language: payload.language,
    fileName: payload.fileName,
    requestedFormat,
    verify: payload.verify !== false,
    sourceCode: payload.code,
    sourceSha256,
    proofState: normalizeProofState(closure.proofState) || null,
    verificationStatus: null,
    problemId: null,
    plan: {
      schema: 'ivucx-conversion-plan-v1',
      stateStore: client ? 'supabase' : 'memory',
      planner: 'railway',
      executor: executionBackend,
      operation,
      requestedFormat,
      fallbackFormat: String(requestedFormat || '').trim().toLowerCase() === 'cic-v1' ? 'typed-lambda-v1' : null,
      sourceBytes,
      sourceSha256,
      language: payload.language.toLowerCase(),
      verify: payload.verify !== false,
      routes: {
        convert: EXECUTION_SERVER_CONVERT_ROUTE,
        leanCheck: EXECUTION_SERVER_LEAN_CHECK_ROUTE,
        coqCheck: EXECUTION_SERVER_COQ_CHECK_ROUTE
      },
      execution: {
        baseUrl: executionInfo.baseUrl,
        source: executionInfo.source,
        backend: executionBackend,
        github: executionInfo.github && executionInfo.github.enabled ? executionInfo.github : null
      }
    },
    progress: createProgress(12, 'planning', 'Planning'),
    executionPayload: {
      language: payload.language,
      fileName: payload.fileName,
      format: requestedFormat,
      verify: payload.verify !== false,
      executionBaseUrl: executionInfo.baseUrl,
      helperBaseUrl: executionInfo.helperBaseUrl,
      sourceSha256,
      sourceBytes
    },
    executionResult: null,
    executionError: null,
    requestMeta: {
      sourceBytes,
      createdBy: 'railway-helper',
      requestId: req && req.id ? req.id : null,
      executionBaseUrl: executionInfo.baseUrl,
      executionSource: executionInfo.source,
      executionBackend,
      helperBaseUrl: executionInfo.helperBaseUrl,
      helperJobId: helperJobId || null,
      githubActions: {
        executionToken: githubExecutionToken,
        issuedAt: createdAt
      }
    },
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null
  };

  await persistPlan(plan);
  return plan;
}

async function dispatchPlannedJob(jobId) {
  const job = await getJob(jobId);
  if (!job || job.status !== JOB_STATUS.QUEUED) {
    return job;
  }

  if (isGitHubExecutionConfigured()) {
    const plan = await getPlan(job.planId);
    if (!plan) {
      throw new Error('Conversion plan not found.');
    }

    job.status = JOB_STATUS.RUNNING;
    job.startedAt = nowIso();
    job.progress = createProgress(24, 'dispatching', 'Dispatching to GitHub Actions');
    await persistJob(job);

    await updatePlanProgress(plan.id, PLAN_STATUS.RUNNING, createProgress(28, 'dispatching', 'Dispatching to GitHub Actions'));

    try {
      await dispatchGitHubPlannedJob(job, plan);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      await completeGitHubJobFailure(plan, job, message);
      throw error;
    }

    return getJob(job.id);
  }

  queueMicrotask(() => {
    executeJob(job.id).catch((err) => {
      console.error('helper job failed', err);
    });
  });

  return job;
}

function isTerminalJobStatus(status) {
  return status === JOB_STATUS.SUCCEEDED || status === JOB_STATUS.FAILED;
}

function waitForDuration(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForJobTerminalState(jobId, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || GITHUB_EXECUTION_SYNC_WAIT_TIMEOUT_MS) || GITHUB_EXECUTION_SYNC_WAIT_TIMEOUT_MS);
  const pollMs = Math.max(250, Number(options.pollMs || GITHUB_EXECUTION_SYNC_WAIT_POLL_MS) || GITHUB_EXECUTION_SYNC_WAIT_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  let latest = null;

  while (Date.now() <= deadline) {
    latest = await getJob(jobId);
    if (!latest) {
      return null;
    }
    if (isTerminalJobStatus(latest.status)) {
      return latest;
    }
    await waitForDuration(pollMs);
  }

  return latest && isTerminalJobStatus(latest.status) ? latest : null;
}

async function dispatchGitHubPlannedJob(job, plan) {
  const helperBaseUrl = resolveHelperPublicBaseUrl(plan);
  if (!helperBaseUrl) {
    const error = new Error(
      'No helper public base URL is available for GitHub Actions callbacks. Set HELPER_PUBLIC_BASE_URL.'
    );
    error.statusCode = 503;
    throw error;
  }
  const helperAccessToken = getGitHubExecutionAccessToken(plan);
  if (!helperAccessToken) {
    const error = new Error(
      'No GitHub Actions execution token is available for this plan.'
    );
    error.statusCode = 503;
    throw error;
  }

  await dispatchGitHubExecutionRun({
    helperJobId: job.id,
    planId: plan.id,
    operation: plan.operation,
    language: plan.language,
    format: plan.requestedFormat,
    helperBaseUrl,
    helperAccessToken,
    requestId: plan.requestMeta && plan.requestMeta.requestId ? plan.requestMeta.requestId : ''
  });

  job.progress = createProgress(36, 'queued', 'Queued on GitHub Actions');
  await persistJob(job);

  await updatePlanProgress(plan.id, PLAN_STATUS.RUNNING, createProgress(38, 'queued', 'Queued on GitHub Actions'));
}

async function executeJob(jobId) {
  const job = await getJob(jobId);
  if (!job || job.status !== JOB_STATUS.QUEUED) return;

  job.status = JOB_STATUS.RUNNING;
  job.startedAt = nowIso();
  job.progress = createProgress(18, 'loading', 'Loading plan');
  await persistJob(job);

  try {
    const plan = await getPlan(job.planId);
    if (!plan) {
      throw new Error('Conversion plan not found.');
    }

    if (isGitHubExecutionConfigured()) {
      await dispatchGitHubPlannedJob(job, plan);
      return;
    }

    const result = await executePlannedOperation(plan, job);
    job.completedAt = nowIso();

    if (result.ok) {
      job.status = JOB_STATUS.SUCCEEDED;
      job.result = result;
      job.problemId = result.problemId || null;
      job.progress = createProgress(100, 'saved', result.problemId ? 'Problem saved' : 'Converted');
    } else {
      job.status = JOB_STATUS.FAILED;
      job.result = result;
      job.error = buildJobError(result);
      job.progress = createProgress(100, 'failed', job.error.message || 'Conversion failed');
    }

    await persistJob(job);
  } catch (err) {
    job.status = JOB_STATUS.FAILED;
    job.completedAt = nowIso();
    job.error = { message: err && err.message ? err.message : String(err) };
    job.progress = createProgress(100, 'failed', job.error.message);
    await persistJob(job);
    if (job.planId) {
      await markPlanFailed(job.planId, job.error.message, job.progress);
    }
  }
}
async function executePlannedOperation(plan, job) {
  await updatePlanProgress(plan.id, PLAN_STATUS.PLANNING, createProgress(22, 'loading', 'Loading source'));
  if (job) {
    job.progress = createProgress(22, 'loading', 'Loading source');
    await persistJob(job);
  }

  const currentPlan = await getPlan(plan.id);
  if (!currentPlan) {
    throw new Error('Stored conversion plan was not found.');
  }

  await updatePlanProgress(currentPlan.id, PLAN_STATUS.READY, createProgress(34, 'prepared', 'Prepared'));
  if (job) {
    job.progress = createProgress(34, 'prepared', 'Prepared');
    await persistJob(job);
  }

  let execution = await executeRemoteConversion(currentPlan, currentPlan.requestedFormat);
  let finalResult = execution.result;
  let completedFormat = execution.completedFormat;
  let fallbackUsed = false;

  if (!finalResult.ok && shouldRetryWithTypedLambda(currentPlan.requestedFormat, extractResultMessage(finalResult))) {
    fallbackUsed = true;
    await updatePlanProgress(currentPlan.id, PLAN_STATUS.RUNNING, createProgress(56, 'fallback', 'Retrying typed lambda'));
    if (job) {
      job.progress = createProgress(56, 'fallback', 'Retrying typed lambda');
      await persistJob(job);
    }
    execution = await executeRemoteConversion(currentPlan, 'typed-lambda-v1');
    finalResult = execution.result;
    completedFormat = execution.completedFormat;
  }

  const proofState = resolveStoredProofState(currentPlan.language, currentPlan.sourceCode, finalResult);
  finalResult.proofState = proofState;
  finalResult.planning = {
    planId: currentPlan.id,
    operation: currentPlan.operation,
    stateStore: 'supabase',
    planner: 'railway',
    executor: 'execution-server',
    requestedFormat: currentPlan.requestedFormat,
    completedFormat,
    fallbackUsed
  };

  if (!finalResult.ok) {
    await persistExecutionOutcome(currentPlan.id, {
      status: PLAN_STATUS.FAILED,
      progress: createProgress(100, 'failed', extractResultMessage(finalResult)),
      result: finalResult,
      error: buildExecutionErrorObject(finalResult),
      proofState,
      verificationStatus: resolveVerificationStatus(finalResult),
      problemId: null,
      completedAt: nowIso()
    });
    return finalResult;
  }

  let problemId = null;
  if (currentPlan.operation === 'submit') {
    await updatePlanProgress(currentPlan.id, PLAN_STATUS.RUNNING, createProgress(82, 'saving', 'Saving problem'));
    if (job) {
      job.progress = createProgress(82, 'saving', 'Saving problem');
      await persistJob(job);
    }
    const saved = await saveProblemRecord(currentPlan, finalResult, proofState, completedFormat);
    problemId = saved.id || null;
    finalResult.problemId = problemId;
    if (saved.memoryFallback) {
      finalResult.storage = {
        persisted: false,
        reason: saved.warning || 'Problem storage is not configured on the helper server.'
      };
    }
  }

  await persistExecutionOutcome(currentPlan.id, {
    status: PLAN_STATUS.SUCCEEDED,
    progress: createProgress(100, 'saved', problemId ? 'Problem saved' : 'Converted'),
    result: finalResult,
    error: null,
    proofState,
    verificationStatus: resolveVerificationStatus(finalResult),
    problemId,
    completedAt: nowIso()
  });

  return finalResult;
}

async function handleGitHubActionsCallback(body, req) {
  const planId = String(body.planId || '').trim();
  const helperJobId = String(body.helperJobId || '').trim();
  const operation = String(body.operation || '').trim().toLowerCase();

  if (!planId || !helperJobId || !operation) {
    const error = new Error('planId, helperJobId, and operation are required');
    error.statusCode = 400;
    throw error;
  }

  const plan = await getPlan(planId);
  if (!plan) {
    const error = new Error('Conversion plan not found.');
    error.statusCode = 404;
    throw error;
  }
  assertGitHubExecutionBridgeAccess(plan, req);

  const job = await getJob(helperJobId);
  if (!job) {
    const error = new Error('Helper job not found.');
    error.statusCode = 404;
    throw error;
  }

  if (operation === 'check') {
    await finalizeGitHubCheckCallback(plan, job, body);
    await revokeGitHubExecutionAccessToken(plan);
    return;
  }

  await finalizeGitHubConversionCallback(plan, job, body);
  await revokeGitHubExecutionAccessToken(plan);
}

async function finalizeGitHubCheckCallback(plan, job, body) {
  const verification = body.verification && typeof body.verification === 'object'
    ? body.verification
    : (
      body.result && typeof body.result === 'object' && body.result.verification && typeof body.result.verification === 'object'
        ? body.result.verification
        : null
    );

  if (!verification) {
    const message = extractGitHubCallbackError(body) || 'GitHub Actions proof check did not return a verification payload.';
    await completeGitHubJobFailure(plan, job, message);
    return;
  }

  const normalizedVerification = {
    ...verification,
    source: 'github-actions',
    proofState: normalizeProofState(analyzeProofState(plan.language, plan.sourceCode).proofState) || 'NN'
  };

  const resultPayload = {
    ok: Boolean(normalizedVerification.ok),
    verification: normalizedVerification
  };

  if (!normalizedVerification.ok) {
    const message = extractVerificationMessage(normalizedVerification);
    job.result = resultPayload;
    await persistExecutionOutcome(plan.id, {
      status: PLAN_STATUS.FAILED,
      progress: createProgress(100, 'failed', message),
      result: resultPayload,
      error: {
        message,
        stage: 'proof-check',
        httpStatus: normalizedVerification.upstreamStatus || normalizedVerification.httpStatus || 422,
        timedOut: !!normalizedVerification.timedOut
      },
      proofState: normalizedVerification.proofState,
      verificationStatus: resolveVerificationStatus(resultPayload),
      problemId: null,
      completedAt: nowIso()
    });

    job.status = JOB_STATUS.FAILED;
    job.completedAt = nowIso();
    job.error = { message };
    job.progress = createProgress(100, 'failed', message);
    await persistJob(job);
    return;
  }

  await persistExecutionOutcome(plan.id, {
    status: PLAN_STATUS.SUCCEEDED,
    progress: createProgress(100, 'checked', 'Proof checked'),
    result: resultPayload,
    error: null,
    proofState: normalizedVerification.proofState,
    verificationStatus: resolveVerificationStatus(resultPayload),
    problemId: null,
    completedAt: nowIso()
  });

  job.status = JOB_STATUS.SUCCEEDED;
  job.completedAt = nowIso();
  job.result = resultPayload;
  job.error = null;
  job.progress = createProgress(100, 'checked', 'Proof checked');
  await persistJob(job);
}

async function finalizeGitHubConversionCallback(plan, job, body) {
  const completedFormat = String(body.completedFormat || '').trim() || plan.requestedFormat;
  const fallbackUsed = Boolean(body.fallbackUsed);
  const workflowMeta = body.workflow && typeof body.workflow === 'object' ? body.workflow : null;
  const fallbackMeta = body.fallback && typeof body.fallback === 'object' ? body.fallback : null;

  let finalResult = body.result && typeof body.result === 'object'
    ? { ...body.result }
    : null;

  if (!finalResult) {
    finalResult = {
      ok: false,
      stage: 'conversion',
      timedOut: false,
      httpStatus: 502,
      language: plan.language.toLowerCase(),
      verifyBeforeConvert: plan.verify,
      proofCheck: null,
      conversion: {
        ok: false,
        language: plan.language.toLowerCase(),
        targetFamily: String(completedFormat || '').trim().toLowerCase() === 'cic-v1' ? 'cic' : 'typed-lambda',
        requestedFormat: plan.requestedFormat,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: null,
        codeBytes: Buffer.byteLength(plan.sourceCode || '', 'utf8'),
        codeHash: plan.sourceSha256,
        stdout: '',
        stderr: extractGitHubCallbackError(body),
        lambda: {
          format: completedFormat,
          error: extractGitHubCallbackError(body)
        }
      }
    };
  }

  const proofState = resolveStoredProofState(plan.language, plan.sourceCode, finalResult);
  finalResult.proofState = proofState;
  finalResult.planning = {
    planId: plan.id,
    operation: plan.operation,
    stateStore: 'supabase',
    planner: 'railway',
    executor: 'github-actions',
    requestedFormat: plan.requestedFormat,
    completedFormat,
    fallbackUsed,
    fallback: fallbackMeta,
    workflow: workflowMeta
  };

  if (!finalResult.ok) {
    const message = extractResultMessage(finalResult);
    job.result = finalResult;
    await persistExecutionOutcome(plan.id, {
      status: PLAN_STATUS.FAILED,
      progress: createProgress(100, 'failed', message),
      result: finalResult,
      error: buildExecutionErrorObject(finalResult),
      proofState,
      verificationStatus: resolveVerificationStatus(finalResult),
      problemId: null,
      completedAt: nowIso()
    });

    job.status = JOB_STATUS.FAILED;
    job.completedAt = nowIso();
    job.error = buildJobError(finalResult);
    job.progress = createProgress(100, 'failed', job.error.message || 'Conversion failed');
    await persistJob(job);
    return;
  }

  let problemId = null;
  if (plan.operation === 'submit') {
    const saved = await saveProblemRecord(plan, finalResult, proofState, completedFormat);
    problemId = saved.id || null;
    finalResult.problemId = problemId;
    if (saved.memoryFallback) {
      finalResult.storage = {
        persisted: false,
        reason: saved.warning || 'Problem storage is not configured on the helper server.'
      };
    }
  }

  await persistExecutionOutcome(plan.id, {
    status: PLAN_STATUS.SUCCEEDED,
    progress: createProgress(100, 'saved', problemId ? 'Problem saved' : 'Converted'),
    result: finalResult,
    error: null,
    proofState,
    verificationStatus: resolveVerificationStatus(finalResult),
    problemId,
    completedAt: nowIso()
  });

  job.status = JOB_STATUS.SUCCEEDED;
  job.completedAt = nowIso();
  job.result = finalResult;
  job.error = null;
  job.problemId = problemId || null;
  job.progress = createProgress(100, 'saved', problemId ? 'Problem saved' : 'Converted');
  await persistJob(job);
}

async function completeGitHubJobFailure(plan, job, message) {
  await markPlanFailed(plan.id, message, createProgress(100, 'failed', message));
  job.status = JOB_STATUS.FAILED;
  job.completedAt = nowIso();
  job.error = { message };
  job.progress = createProgress(100, 'failed', message);
  await persistJob(job);
}

function extractGitHubCallbackError(body) {
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error.trim();
    }
    if (body.error && typeof body.error === 'object' && typeof body.error.message === 'string' && body.error.message.trim()) {
      return body.error.message.trim();
    }
  }

  return 'GitHub Actions execution failed.';
}

function extractVerificationMessage(verification) {
  if (!verification || typeof verification !== 'object') {
    return 'Proof check failed.';
  }

  if (typeof verification.error === 'string' && verification.error.trim()) {
    return verification.error.trim();
  }
  if (typeof verification.stderr === 'string' && verification.stderr.trim()) {
    return verification.stderr.trim();
  }
  if (typeof verification.stdout === 'string' && verification.stdout.trim()) {
    return verification.stdout.trim();
  }

  return 'Proof check failed.';
}

function toLegacyProofCheckBody(verification) {
  const normalized = verification && typeof verification === 'object' ? verification : {};
  const body = {
    ok: Boolean(normalized.ok),
    status: normalized.timedOut ? 'timeout' : (normalized.ok ? 'ok' : 'error'),
    exitCode: typeof normalized.exitCode === 'number' ? normalized.exitCode : null,
    signal: normalized.signal || null,
    durationMs: typeof normalized.durationMs === 'number' ? normalized.durationMs : null,
    stdout: typeof normalized.stdout === 'string' ? normalized.stdout : '',
    stderr: typeof normalized.stderr === 'string' ? normalized.stderr : ''
  };
  if (typeof normalized.error === 'string' && normalized.error.trim()) {
    body.error = normalized.error.trim();
  }
  return body;
}

function ensureExternalExecutionProxyTarget(req) {
  const executionInfo = getExecutionInfo(req);
  if (!executionInfo.configured || !executionInfo.baseUrl) {
    const error = new Error(
      'No execution server base URL is available on the helper server. Set EXECUTION_SERVER_BASE_URL or enable GitHub Actions execution.'
    );
    error.statusCode = 503;
    throw error;
  }

  const helperBaseUrl = resolveHelperPublicBaseUrl(req);
  if (helperBaseUrl && normalizeRemoteBaseUrl(helperBaseUrl) === normalizeRemoteBaseUrl(executionInfo.baseUrl)) {
    const error = new Error(
      'EXECUTION_SERVER_BASE_URL points back to this helper service. Point it at a separate execution API or enable GitHub Actions execution.'
    );
    error.statusCode = 503;
    throw error;
  }
}

function forwardExecutionResponse(res, upstream) {
  const payload = upstream && upstream.payload && typeof upstream.payload === 'object'
    ? upstream.payload
    : null;
  if (payload) {
    res.status(upstream.status || 200).json(payload);
    return;
  }
  res
    .status(upstream && upstream.status ? upstream.status : 502)
    .type('application/json')
    .send(upstream && typeof upstream.text === 'string' ? upstream.text : JSON.stringify({ ok: false, error: 'Invalid execution response.' }));
}

async function requirePlan(planId) {
  const plan = await getPlan(planId);
  if (!plan) {
    const error = new Error('Conversion plan not found.');
    error.statusCode = 404;
    throw error;
  }
  return plan;
}

async function normalizeCompatibilityConvertPayload(body) {
  const normalizedBody = body && typeof body === 'object' ? body : {};
  const planId = typeof normalizedBody.planId === 'string' ? normalizedBody.planId.trim() : '';
  const hasInlineCode = typeof normalizedBody.code === 'string' && normalizedBody.code.trim();

  if (planId && !hasInlineCode) {
    return {
      planId
    };
  }

  return normalizeProofPayload(normalizedBody);
}

function buildGitHubExecutionFailureResult(job, payload, operation = 'convert') {
  const message = job && job.error && job.error.message
    ? job.error.message
    : 'GitHub Actions execution failed.';
  const requestedFormat = defaultRequestedFormat(operation, payload || {});
  return {
    ok: false,
    stage: operation === 'check' ? 'proof-check' : 'conversion',
    timedOut: false,
    httpStatus: 502,
    language: payload && payload.language ? String(payload.language).toLowerCase() : null,
    verifyBeforeConvert: payload && Object.prototype.hasOwnProperty.call(payload, 'verify') ? payload.verify !== false : true,
    proofCheck: operation === 'check'
      ? {
        ok: false,
        error: message,
        source: 'github-actions'
      }
      : null,
    conversion: operation === 'check'
      ? null
      : {
        ok: false,
        language: payload && payload.language ? String(payload.language).toLowerCase() : null,
        targetFamily: String(requestedFormat).toLowerCase() === 'cic-v1' ? 'cic' : 'typed-lambda',
        requestedFormat,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: null,
        codeBytes: payload && typeof payload.code === 'string' ? Buffer.byteLength(payload.code, 'utf8') : null,
        codeHash: payload && typeof payload.code === 'string' ? sha256(payload.code) : null,
        stdout: '',
        stderr: message,
        lambda: {
          format: requestedFormat,
          error: message
        }
      }
  };
}

async function executeRemoteConversion(plan, format) {
  const executionInfo = getExecutionInfo(plan);
  if (!executionInfo.configured || !executionInfo.baseUrl) {
    const error = new Error(
      'No execution server base URL is available on the helper server. Set EXECUTION_SERVER_BASE_URL or switch to GitHub Actions execution.'
    );
    error.statusCode = 503;
    throw error;
  }

  await updatePlanProgress(plan.id, PLAN_STATUS.RUNNING, createProgress(46, 'running', 'Running on execution server'));

  const executionPayload = {
    planId: plan.id,
    title: plan.title || '',
    language: plan.language,
    fileName: plan.fileName,
    code: plan.sourceCode,
    format,
    verify: plan.verify,
    sourceSha256: plan.sourceSha256 || null
  };

  const upstream = await sendExecutionRequest(EXECUTION_SERVER_CONVERT_ROUTE, executionPayload, executionInfo.baseUrl);
  const payload = upstream.payload && typeof upstream.payload === 'object' ? upstream.payload : null;

  if (payload && payload.result && typeof payload.result === 'object') {
    const result = {
      ...payload.result,
      requestedFormat: plan.requestedFormat,
      completedFormat: format
    };
    return { result, completedFormat: format };
  }

  const message = extractExecutionError(payload, upstream.text, upstream.status);
  return {
    completedFormat: format,
    result: {
      ok: false,
      stage: 'conversion',
      timedOut: upstream.status === 504,
      httpStatus: upstream.status >= 400 ? upstream.status : 502,
      language: plan.language.toLowerCase(),
      verifyBeforeConvert: plan.verify,
      proofCheck: null,
      conversion: {
        ok: false,
        language: plan.language.toLowerCase(),
        targetFamily: String(format || '').trim().toLowerCase() === 'cic-v1' ? 'cic' : 'typed-lambda',
        requestedFormat: plan.requestedFormat,
        exitCode: null,
        signal: null,
        timedOut: upstream.status === 504,
        durationMs: null,
        codeBytes: Buffer.byteLength(plan.sourceCode || '', 'utf8'),
        codeHash: plan.sourceSha256,
        stdout: '',
        stderr: message,
        lambda: {
          format,
          error: message
        }
      }
    }
  };
}

function shouldRetryWithTypedLambda(requestedFormat, message) {
  if (String(requestedFormat || '').trim().toLowerCase() !== 'cic-v1') {
    return false;
  }
  const normalized = String(message || '').trim().toLowerCase();
  return (
    normalized.includes('lean cic exporter failed')
    || normalized.includes('coq cic')
    || normalized.includes('bad gateway')
    || normalized.includes('service unavailable')
    || normalized.includes('gateway timeout')
    || normalized.includes('invalid response')
    || normalized.includes('unknown module prefix')
  );
}

async function requestExecutionCheck(payload, req) {
  const route = payload.language === 'Coq' ? EXECUTION_SERVER_COQ_CHECK_ROUTE : EXECUTION_SERVER_LEAN_CHECK_ROUTE;
  const executionInfo = getExecutionInfo(req);
  if (!executionInfo.configured || !executionInfo.baseUrl) {
    const error = new Error(
      'No execution server base URL is available on the helper server. Set EXECUTION_SERVER_BASE_URL or use async GitHub Actions execution.'
    );
    error.statusCode = 503;
    throw error;
  }
  const upstream = await sendExecutionRequest(route, {
    code: payload.code,
    fileName: payload.fileName
  }, executionInfo.baseUrl);
  const body = upstream.payload && typeof upstream.payload === 'object' ? upstream.payload : {};
  return {
    ok: Boolean(body.ok),
    language: payload.language.toLowerCase(),
    fileName: payload.fileName,
    command: body.command || route,
    args: Array.isArray(body.args) ? body.args : [],
    exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
    signal: body.signal || null,
    timedOut: body.status === 'timeout' || upstream.status === 504,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
    codeBytes: Buffer.byteLength(payload.code, 'utf8'),
    stdout: typeof body.stdout === 'string' ? truncateOutput(body.stdout) : '',
    stderr: typeof body.stderr === 'string' ? truncateOutput(body.stderr) : '',
    error: typeof body.error === 'string' ? body.error : '',
    upstreamStatus: upstream.status,
    source: 'execution-server',
    proofState: normalizeProofState(analyzeProofState(payload.language, payload.code).proofState) || 'NN'
  };
}

function statusCodeForVerification(verification) {
  if (verification.ok) return 200;
  if (verification.timedOut) return 504;
  return verification.upstreamStatus >= 400 ? verification.upstreamStatus : 422;
}

const EXECUTION_REQUEST_RETRY_DELAYS_MS = Object.freeze([0, 1800, 4200, 7000]);

function shouldRetryExecutionStatus(status) {
  return [502, 503, 504].includes(Number(status || 0));
}

function shouldRetryExecutionError(error) {
  if (!error) return false;
  const statusCode = Number(error.statusCode || 0);
  if (shouldRetryExecutionStatus(statusCode)) {
    return true;
  }
  const message = String(error.message || error).trim().toLowerCase();
  return (
    message.includes('bad gateway')
    || message.includes('service unavailable')
    || message.includes('gateway timeout')
    || message.includes('fetch failed')
    || message.includes('econnreset')
    || message.includes('socket hang up')
    || message.includes('timed out')
    || message.includes('timeout')
  );
}

async function waitExecutionRetry(delayMs) {
  if (!(delayMs > 0)) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function sendExecutionRequest(targetPath, body, executionBaseUrl = EXECUTION_SERVER_BASE_URL) {
  let headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  if (EXECUTION_SERVER_API_KEY) {
    headers.Authorization = `Bearer ${EXECUTION_SERVER_API_KEY}`;
  }

  const normalizedBaseUrl = String(executionBaseUrl || '').replace(/\/+$/, '');
  if (isLikelyOracleControlPlaneUrl(normalizedBaseUrl)) {
    const error = new Error(
      `Execution server base URL looks like the Oracle Cloud control-plane endpoint (${normalizedBaseUrl}). Set EXECUTION_SERVER_BASE_URL to the public URL of the Oracle-server app.`
    );
    error.statusCode = 503;
    throw error;
  }

  const requestBody = JSON.stringify(body || {});
  headers = await attachExecutionRequestAuthHeaders({
    headers,
    method: 'POST',
    targetPath,
    bodyText: requestBody
  });
  let lastError = null;

  for (let attemptIndex = 0; attemptIndex < EXECUTION_REQUEST_RETRY_DELAYS_MS.length; attemptIndex += 1) {
    const retryDelayMs = EXECUTION_REQUEST_RETRY_DELAYS_MS[attemptIndex];
    if (retryDelayMs > 0) {
      await waitExecutionRetry(retryDelayMs);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXECUTION_SERVER_TIMEOUT_MS);

    try {
      const response = await fetch(normalizedBaseUrl + targetPath, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller.signal
      });
      const text = await response.text();
      clearTimeout(timer);
      const result = {
        ok: response.ok,
        status: response.status,
        text,
        payload: tryParseJson(text)
      };
      if (shouldRetryExecutionStatus(response.status) && attemptIndex < EXECUTION_REQUEST_RETRY_DELAYS_MS.length - 1) {
        const transientError = new Error(`Execution server returned ${response.status}.`);
        transientError.statusCode = response.status;
        lastError = transientError;
        continue;
      }
      return result;
    } catch (err) {
      clearTimeout(timer);
      const timedOut = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
      const error = new Error(
        timedOut
          ? 'Execution server timed out while running the requested proof task.'
          : (err && err.message ? err.message : String(err))
      );
      error.statusCode = timedOut ? 504 : 502;
      if (attemptIndex < EXECUTION_REQUEST_RETRY_DELAYS_MS.length - 1 && shouldRetryExecutionError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('Execution server request failed.');
}

function extractExecutionError(payload, rawText, status) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (payload.details && typeof payload.details === 'object') {
      if (typeof payload.details.error === 'string' && payload.details.error.trim()) {
        return payload.details.error.trim();
      }
      if (typeof payload.details.stderr === 'string' && payload.details.stderr.trim()) {
        return payload.details.stderr.trim();
      }
    }
  }
  if (typeof rawText === 'string' && rawText.trim()) {
    return truncateOutput(rawText.trim());
  }
  return `Execution server returned ${status || 502}.`;
}
async function saveProblemRecord(plan, result, proofState, completedFormat) {
  const { client, error } = getSupabaseAdmin();
  if (!client) {
    if (ENABLE_MEMORY_SCHEMA_FALLBACK) {
      return {
        id: null,
        created_at: nowIso(),
        memoryFallback: true,
        warning: error || 'Problem storage is not configured on the helper server.'
      };
    }
    throw new Error(error || 'Problem storage is not configured on the helper server.');
  }

  const conversion = result && result.conversion && typeof result.conversion === 'object'
    ? result.conversion
    : {};
  const lambda = conversion.lambda && typeof conversion.lambda === 'object'
    ? conversion.lambda
    : {};
  const executorName = result && result.planning && result.planning.executor
    ? String(result.planning.executor)
    : 'execution-server';

  const record = {
    title: plan.title || '',
    language: plan.language.toLowerCase(),
    file_name: plan.fileName || '',
    source_code: plan.sourceCode,
    source_sha256: plan.sourceSha256,
    proof_state: proofState,
    verification_status: resolveVerificationStatus(result),
    verification_result: {
      proofCheck: result && result.proofCheck ? result.proofCheck : null,
      planning: result && result.planning ? result.planning : null
    },
    normalized_format: lambda.format || completedFormat || plan.requestedFormat,
    normalized_term: lambda.term && typeof lambda.term === 'object' ? lambda.term : (lambda && Object.keys(lambda).length ? lambda : { raw: String(lambda.error || '') }),
    adapter_name: executorName === 'github-actions' ? 'github-actions-proof-executor' : 'execution-server-proof-convert',
    adapter_meta: {
      planner: 'railway',
      executor: executorName,
      planId: plan.id,
      operation: plan.operation,
      targetFamily: conversion.targetFamily || null,
      requestedFormat: plan.requestedFormat,
      completedFormat: lambda.format || completedFormat || plan.requestedFormat,
      fallbackUsed: !!(result && result.planning && result.planning.fallbackUsed),
      context: lambda.context || null,
      declarations: lambda.declarations || null,
      metadata: lambda.metadata || null,
      rawText: typeof lambda.rawText === 'string' ? truncateOutput(lambda.rawText, 24000) : ''
    },
    helper_job_id: plan.helperJobId || null,
    request_meta: {
      sourceLanguage: plan.language,
      fileName: plan.fileName,
      sourceBytes: Buffer.byteLength(plan.sourceCode, 'utf8'),
      planId: plan.id,
      planOperation: plan.operation
    }
  };

  return insertProblemRecordWithFallback(client, record);
}

async function insertProblemRecordWithFallback(client, record) {
  const mutableRecord = { ...(record || {}) };
  const droppedColumns = [];
  let bootstrapRetried = false;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { data, error: insertError } = await client
      .from('problems')
      .insert(mutableRecord)
      .select('id, created_at')
      .single();

    if (!insertError) {
      return {
        ...(data || { id: null, created_at: nowIso() }),
        droppedColumns
      };
    }

    const missingColumn = extractMissingSupabaseColumn(insertError, 'problems');
    if (missingColumn && Object.prototype.hasOwnProperty.call(mutableRecord, missingColumn)) {
      if (!bootstrapRetried) {
        bootstrapRetried = true;
        const bootstrap = await ensureSupabaseSchema(`problems-column:${missingColumn}`);
        if (bootstrap.ok) {
          continue;
        }
      }
      delete mutableRecord[missingColumn];
      droppedColumns.push(missingColumn);
      continue;
    }

    if (missingColumn) {
      if (!bootstrapRetried) {
        bootstrapRetried = true;
        const bootstrap = await ensureSupabaseSchema(`problems-column:${missingColumn}`);
        if (bootstrap.ok) {
          continue;
        }
      }
      throw createMissingSupabaseColumnError('problems', missingColumn, insertError);
    }

    if (isMissingSupabaseRelationError(insertError, 'problems')) {
      if (!bootstrapRetried) {
        bootstrapRetried = true;
        const bootstrap = await ensureSupabaseSchema('problems-table');
        if (bootstrap.ok) {
          continue;
        }
      }
      throw createMissingSupabaseTableError('problems', insertError);
    }
    throw new Error(insertError.message || 'Failed to save problem row.');
  }

  throw new Error('Failed to save problem row after retrying without missing Supabase columns.');
}

function resolveVerificationStatus(result) {
  if (!result) return 'failed';
  if (result.verifyBeforeConvert === false) return 'skipped';
  return result.ok ? 'verified' : 'failed';
}

function resolveStoredProofState(language, code, result) {
  const closure = analyzeProofState(language, code);
  const coarse = normalizeProofState(closure.proofState) || 'NN';
  if (result && result.ok) {
    return coarse;
  }
  if (coarse === 'NY') {
    return 'NY';
  }
  return 'NN';
}

function buildJobError(result) {
  return {
    message: extractResultMessage(result),
    stage: result && result.stage ? result.stage : 'conversion',
    httpStatus: result && typeof result.httpStatus === 'number' ? result.httpStatus : 422,
    timedOut: !!(result && result.timedOut)
  };
}

function buildExecutionErrorObject(result) {
  return {
    message: extractResultMessage(result),
    stage: result && result.stage ? result.stage : 'conversion',
    httpStatus: result && typeof result.httpStatus === 'number' ? result.httpStatus : 422,
    timedOut: !!(result && result.timedOut)
  };
}

function extractResultMessage(result) {
  if (!result || typeof result !== 'object') {
    return 'Helper conversion failed.';
  }
  if (result.proofCheck && typeof result.proofCheck.error === 'string' && result.proofCheck.error.trim()) {
    return result.proofCheck.error.trim();
  }
  if (result.conversion && typeof result.conversion === 'object') {
    const lambda = result.conversion.lambda;
    if (lambda && typeof lambda === 'object' && typeof lambda.error === 'string' && lambda.error.trim()) {
      return lambda.error.trim();
    }
    if (typeof result.conversion.stderr === 'string' && result.conversion.stderr.trim()) {
      return result.conversion.stderr.trim();
    }
    if (typeof result.conversion.stdout === 'string' && result.conversion.stdout.trim()) {
      return result.conversion.stdout.trim();
    }
  }
  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error.trim();
  }
  return 'Helper conversion failed.';
}

function statusCodeForResult(result) {
  if (result && typeof result.httpStatus === 'number' && result.httpStatus >= 400) {
    return result.httpStatus;
  }
  if (result && result.ok) {
    return 200;
  }
  if (result && result.timedOut) {
    return 504;
  }
  return 422;
}

async function persistExecutionOutcome(planId, outcome) {
  const plan = await getPlan(planId);
  if (!plan) return;
  plan.status = outcome.status;
  plan.progress = outcome.progress || plan.progress;
  plan.executionResult = outcome.result || null;
  plan.executionError = outcome.error || null;
  plan.proofState = outcome.proofState || null;
  plan.verificationStatus = outcome.verificationStatus || null;
  plan.problemId = outcome.problemId || null;
  plan.completedAt = outcome.completedAt || nowIso();
  if (!plan.startedAt) {
    plan.startedAt = nowIso();
  }
  await persistPlan(plan);
}

async function markPlanFailed(planId, message, progress) {
  const plan = await getPlan(planId);
  if (!plan) return;
  plan.status = PLAN_STATUS.FAILED;
  plan.progress = progress || createProgress(100, 'failed', message || 'Failed');
  plan.executionError = { message: message || 'Failed' };
  plan.completedAt = nowIso();
  await persistPlan(plan);
}

async function updatePlanProgress(planId, status, progress) {
  const plan = await getPlan(planId);
  if (!plan) return;
  plan.status = status;
  plan.progress = progress || plan.progress;
  if (!plan.startedAt && (status === PLAN_STATUS.RUNNING || status === PLAN_STATUS.READY)) {
    plan.startedAt = nowIso();
  }
  await persistPlan(plan);
}

async function getJob(id) {
  const memory = jobs.get(id);
  if (memory) return memory;
  const persisted = await loadPersistedJob(id);
  if (persisted) {
    return persisted;
  }
  return loadSynthesizedJobFromPlan(id);
}

async function listJobs() {
  const { client } = getSupabaseAdmin();
  if (!client) {
    return listMemoryAndPlanJobs();
  }
  const { data, error } = await client
    .from('helper_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error && shouldFallbackForMissingTable(error, 'helper_jobs')) {
    return listMemoryAndPlanJobs();
  }
  if (error && isMissingSupabaseRelationError(error, 'helper_jobs')) {
    throw createMissingSupabaseTableError('helper_jobs', error);
  }
  if (error) {
    return listMemoryAndPlanJobs();
  }
  return Array.isArray(data) ? data.map(hydrateJobRow) : [];
}

function listMemoryAndPlanJobs() {
  const merged = new Map();

  for (const [jobId, job] of jobs.entries()) {
    merged.set(jobId, job);
  }

  for (const plan of plans.values()) {
    const synthesized = synthesizeJobFromPlan(plan);
    if (synthesized && !merged.has(synthesized.id)) {
      merged.set(synthesized.id, synthesized);
    }
  }

  return Array.from(merged.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function loadPersistedJob(id) {
  const { client } = getSupabaseAdmin();
  if (!client) {
    const diskJob = await readDiskState('jobs', id);
    if (diskJob && diskJob.id) {
      jobs.set(diskJob.id, diskJob);
      return diskJob;
    }
    return null;
  }
  const { data, error } = await client
    .from('helper_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error && shouldFallbackForMissingTable(error, 'helper_jobs')) {
    const diskJob = await readDiskState('jobs', id);
    if (diskJob && diskJob.id) {
      jobs.set(diskJob.id, diskJob);
      return diskJob;
    }
    return jobs.get(id) || null;
  }
  if (error && isMissingSupabaseRelationError(error, 'helper_jobs')) {
    throw createMissingSupabaseTableError('helper_jobs', error);
  }
  if (error || !data) return null;
  const job = hydrateJobRow(data);
  jobs.set(job.id, job);
  return job;
}

async function loadSynthesizedJobFromPlan(jobId) {
  if (!jobId) {
    return null;
  }

  const memoryPlan = Array.from(plans.values()).find((plan) => plan && plan.helperJobId === jobId);
  if (memoryPlan) {
    return synthesizeJobFromPlan(memoryPlan, jobId);
  }

  const { client } = getSupabaseAdmin();
  if (!client) {
    return null;
  }

  const { data, error } = await client
    .from('helper_conversion_plans')
    .select('*')
    .eq('helper_job_id', jobId)
    .maybeSingle();

  if (error && shouldFallbackForMissingTable(error, 'helper_conversion_plans')) {
    return null;
  }
  if (error && isMissingSupabaseRelationError(error, 'helper_conversion_plans')) {
    throw createMissingSupabaseTableError('helper_conversion_plans', error);
  }
  if (error || !data) {
    return null;
  }

  const plan = hydratePlanRow(data);
  plans.set(plan.id, plan);
  return synthesizeJobFromPlan(plan, jobId);
}

function synthesizeJobFromPlan(plan, jobId = null) {
  if (!plan || typeof plan !== 'object') {
    return null;
  }

  const result = plan.executionResult && typeof plan.executionResult === 'object'
    ? plan.executionResult
    : null;
  const error = plan.executionError && typeof plan.executionError === 'object'
    ? plan.executionError
    : null;

  let status = JOB_STATUS.QUEUED;
  if (plan.status === PLAN_STATUS.RUNNING || plan.status === PLAN_STATUS.READY || plan.status === PLAN_STATUS.PLANNING) {
    status = JOB_STATUS.RUNNING;
  } else if (plan.status === PLAN_STATUS.SUCCEEDED) {
    status = JOB_STATUS.SUCCEEDED;
  } else if (plan.status === PLAN_STATUS.FAILED) {
    status = JOB_STATUS.FAILED;
  }

  return {
    id: jobId || plan.helperJobId || plan.id,
    status,
    operation: plan.operation || 'convert',
    title: plan.title || '',
    language: plan.language || 'Lean',
    fileName: plan.fileName || defaultFileName(plan.language || 'Lean'),
    format: plan.requestedFormat || 'typed-lambda-v1',
    sourceSha256: plan.sourceSha256 || '',
    createdAt: plan.createdAt || nowIso(),
    startedAt: plan.startedAt || null,
    completedAt: plan.completedAt || null,
    progress: plan.progress || null,
    result,
    error: status === JOB_STATUS.FAILED ? error : null,
    problemId: plan.problemId || null,
    planId: plan.id
  };
}
function hydrateJobRow(row) {
  return {
    id: row.id,
    status: row.status || JOB_STATUS.FAILED,
    operation: row.operation || 'convert',
    title: row.title || '',
    language: resolveLanguage(row.language || 'Lean'),
    fileName: row.file_name || defaultFileName(resolveLanguage(row.language || 'Lean')),
    format: row.normalized_format || 'typed-lambda-v1',
    sourceSha256: row.source_sha256 || '',
    createdAt: row.created_at || nowIso(),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    progress: row.progress || null,
    result: row.result || null,
    error: row.error || null,
    problemId: row.problem_id || null,
    planId: row.plan_id || null
  };
}

async function persistJob(job) {
  const { client } = getSupabaseAdmin();
  if (!client) {
    jobs.set(job.id, { ...job });
    await writeDiskState('jobs', job.id, { ...job });
    return;
  }
  const { error } = await client.from('helper_jobs').upsert({
    id: job.id,
    status: job.status,
    operation: job.operation || 'convert',
    title: job.title || '',
    language: String(job.language || '').toLowerCase(),
    file_name: job.fileName || '',
    normalized_format: job.format || 'typed-lambda-v1',
    proof_state: job.result && job.result.proofState ? job.result.proofState : null,
    verification_status: job.result ? resolveVerificationStatus(job.result) : null,
    source_sha256: job.sourceSha256 || null,
    progress: job.progress || {},
    result: job.result || null,
    error: job.status === JOB_STATUS.FAILED ? (job.error || null) : null,
    problem_id: job.problemId || null,
    plan_id: job.planId || null,
    created_at: job.createdAt,
    updated_at: nowIso(),
    started_at: job.startedAt,
    completed_at: job.completedAt
  });
  if (error) {
    if (shouldFallbackForMissingTable(error, 'helper_jobs')) {
      jobs.set(job.id, { ...job });
      await writeDiskState('jobs', job.id, { ...job });
      return;
    }
    if (isMissingSupabaseRelationError(error, 'helper_jobs')) {
      throw createMissingSupabaseTableError('helper_jobs', error);
    }
    const writeError = new Error(`Failed to persist helper_jobs row: ${error.message || 'unknown Supabase error'}`);
    writeError.statusCode = 502;
    throw writeError;
  }
}

async function getPlan(id) {
  if (!id) return null;
  const memory = plans.get(id);
  if (memory) return memory;
  return loadPersistedPlan(id);
}

async function loadPersistedPlan(id) {
  const { client } = getSupabaseAdmin();
  if (!client) {
    const diskPlan = await readDiskState('plans', id);
    if (diskPlan && diskPlan.id) {
      plans.set(diskPlan.id, diskPlan);
      return diskPlan;
    }
    return null;
  }
  const { data, error } = await client
    .from('helper_conversion_plans')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error && shouldFallbackForMissingTable(error, 'helper_conversion_plans')) {
    const diskPlan = await readDiskState('plans', id);
    if (diskPlan && diskPlan.id) {
      plans.set(diskPlan.id, diskPlan);
      return diskPlan;
    }
    return plans.get(id) || null;
  }
  if (error && isMissingSupabaseRelationError(error, 'helper_conversion_plans')) {
    throw createMissingSupabaseTableError('helper_conversion_plans', error);
  }
  if (error || !data) return null;
  return hydratePlanRow(data);
}

function hydratePlanRow(row) {
  return {
    id: row.id,
    helperJobId: row.helper_job_id || null,
    operation: row.operation || 'convert',
    status: row.status || PLAN_STATUS.FAILED,
    title: row.title || '',
    language: resolveLanguage(row.language || 'Lean'),
    fileName: row.file_name || defaultFileName(resolveLanguage(row.language || 'Lean')),
    requestedFormat: row.requested_format || 'typed-lambda-v1',
    verify: row.verify !== false,
    sourceCode: row.source_code || '',
    sourceSha256: row.source_sha256 || '',
    plan: row.plan || {},
    progress: row.progress || null,
    executionPayload: row.execution_payload || {},
    executionResult: row.execution_result || null,
    executionError: row.execution_error || null,
    proofState: row.proof_state || null,
    verificationStatus: row.verification_status || null,
    problemId: row.problem_id || null,
    requestMeta: row.request_meta || {},
    createdAt: row.created_at || nowIso(),
    updatedAt: row.updated_at || nowIso(),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null
  };
}

async function persistPlan(plan) {
  const { client } = getSupabaseAdmin();
  if (!client) {
    const memoryPlan = {
      ...plan,
      plan: {
        ...(plan.plan || {}),
        stateStore: HELPER_DISK_STATE_FALLBACK ? 'disk-memory' : 'memory'
      },
      requestMeta: {
        ...(plan.requestMeta || {}),
        schemaFallback: 'supabase-unconfigured'
      }
    };
    Object.assign(plan, memoryPlan);
    plans.set(plan.id, memoryPlan);
    await writeDiskState('plans', plan.id, memoryPlan);
    return;
  }
  const { error } = await client.from('helper_conversion_plans').upsert({
    id: plan.id,
    helper_job_id: plan.helperJobId || null,
    operation: plan.operation || 'convert',
    status: plan.status || PLAN_STATUS.QUEUED,
    title: plan.title || '',
    language: String(plan.language || '').toLowerCase(),
    file_name: plan.fileName || '',
    requested_format: plan.requestedFormat || 'typed-lambda-v1',
    verify: plan.verify !== false,
    source_code: plan.sourceCode || '',
    source_sha256: plan.sourceSha256 || sha256(plan.sourceCode || ''),
    plan: plan.plan || {},
    progress: plan.progress || {},
    execution_payload: plan.executionPayload || {},
    execution_result: plan.executionResult || null,
    execution_error: plan.executionError || null,
    proof_state: plan.proofState || null,
    verification_status: plan.verificationStatus || null,
    problem_id: plan.problemId || null,
    request_meta: plan.requestMeta || {},
    created_at: plan.createdAt || nowIso(),
    updated_at: nowIso(),
    started_at: plan.startedAt,
    completed_at: plan.completedAt
  });
  if (error) {
    if (shouldFallbackForMissingTable(error, 'helper_conversion_plans')) {
      const memoryPlan = {
        ...plan,
        plan: {
          ...(plan.plan || {}),
          stateStore: HELPER_DISK_STATE_FALLBACK ? 'disk-memory' : 'memory'
        },
        requestMeta: {
          ...(plan.requestMeta || {}),
          schemaFallback: 'helper_conversion_plans'
        }
      };
      Object.assign(plan, memoryPlan);
      plans.set(plan.id, memoryPlan);
      await writeDiskState('plans', plan.id, memoryPlan);
      return;
    }
    if (isMissingSupabaseRelationError(error, 'helper_conversion_plans')) {
      throw createMissingSupabaseTableError('helper_conversion_plans', error);
    }
    const writeError = new Error(
      `Failed to persist helper_conversion_plans row: ${error.message || 'unknown Supabase error'}`
    );
    writeError.statusCode = 502;
    throw writeError;
  }
}

function stripLeanCommentsAndStrings(input) {
  let output = '';
  let i = 0;
  let blockCommentDepth = 0;
  let inString = false;
  let inLineComment = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inString = false; }
      i += 1;
      continue;
    }

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        output += ch;
      }
      i += 1;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (ch === '/' && next === '-') { blockCommentDepth += 1; i += 2; continue; }
      if (ch === '-' && next === '/') { blockCommentDepth -= 1; i += 2; continue; }
      i += 1;
      continue;
    }

    if (ch === '"') { inString = true; i += 1; continue; }
    if (ch === '-' && next === '-') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '-') { blockCommentDepth = 1; i += 2; continue; }

    output += ch;
    i += 1;
  }

  return output;
}

function analyzeLeanClosure(code) {
  if (!code || typeof code !== 'string') {
    return { proofState: 'NN', reason: 'Code is empty' };
  }
  const normalized = stripLeanCommentsAndStrings(code).trim();
  if (!normalized) {
    return { proofState: 'NN', reason: 'Code is empty' };
  }
  if (/\b(sorry|admit)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'sorry/admit' };
  }
  if (/(^|\n)\s*(axiom|constant)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'axiom/constant' };
  }
  return { proofState: 'YY', closer: 'Lean checked' };
}

function stripCoqCommentsAndStrings(input) {
  let output = '';
  let i = 0;
  let commentDepth = 0;
  let inString = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inString = false; }
      i += 1;
      continue;
    }

    if (commentDepth > 0) {
      if (ch === '(' && next === '*') { commentDepth += 1; i += 2; continue; }
      if (ch === '*' && next === ')') { commentDepth -= 1; i += 2; continue; }
      i += 1;
      continue;
    }

    if (ch === '"') { inString = true; i += 1; continue; }
    if (ch === '(' && next === '*') { commentDepth = 1; i += 2; continue; }

    output += ch;
    i += 1;
  }

  return output;
}
function isConjectureTail(normalized) {
  const matches = Array.from(normalized.matchAll(/\bConjecture\b/g));
  if (matches.length === 0) return false;
  const last = matches[matches.length - 1];
  const idx = typeof last.index === 'number' ? last.index : -1;
  if (idx < 0) return false;
  const tail = normalized.slice(idx).trim();
  if (!tail.endsWith('.')) return false;
  const dotCount = (tail.match(/\./g) || []).length;
  return dotCount === 1;
}

function analyzeCoqClosure(code) {
  if (!code || typeof code !== 'string') {
    return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
  }
  const normalized = stripCoqCommentsAndStrings(code).trim();
  if (!normalized) {
    return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
  }
  if (/\bAdmitted\./.test(normalized)) return { proofState: 'NY', closer: 'Admitted.' };
  if (/\b(Axiom|Axioms|Parameter|Parameters|Hypothesis|Hypotheses|Variable|Variables|Conjecture)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'Axiom/Parameter/Conjecture' };
  }
  if (isConjectureTail(normalized)) return { proofState: 'NY', closer: 'Conjecture.' };
  if (/Defined\.\s*$/.test(normalized)) return { proofState: 'YY', closer: 'Defined.' };
  if (/Qed\.\s*$/.test(normalized)) return { proofState: 'YY', closer: 'Qed.' };
  return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
}

function analyzeProofState(language, code) {
  return language === 'Coq' ? analyzeCoqClosure(code) : analyzeLeanClosure(code);
}

async function recoverStaleJobs() {
  const { client } = getSupabaseAdmin();
  if (!client) return;
  const now = nowIso();
  const restartMessage = { message: 'Helper server restarted before the job finished.' };
  try {
    const jobsRecovery = await client
      .from('helper_jobs')
      .update({
        status: JOB_STATUS.FAILED,
        error: restartMessage,
        progress: createProgress(100, 'failed', restartMessage.message),
        updated_at: now,
        completed_at: now
      })
      .in('status', [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);
    if (!(jobsRecovery.error && shouldFallbackForMissingTable(jobsRecovery.error, 'helper_jobs'))
      && jobsRecovery.error && isMissingSupabaseRelationError(jobsRecovery.error, 'helper_jobs')) {
      throw createMissingSupabaseTableError('helper_jobs', jobsRecovery.error);
    }

    const plansRecovery = await client
      .from('helper_conversion_plans')
      .update({
        status: PLAN_STATUS.FAILED,
        execution_error: restartMessage,
        progress: createProgress(100, 'failed', restartMessage.message),
        updated_at: now,
        completed_at: now
      })
      .in('status', [PLAN_STATUS.QUEUED, PLAN_STATUS.PLANNING, PLAN_STATUS.READY, PLAN_STATUS.RUNNING]);
    if (!(plansRecovery.error && shouldFallbackForMissingTable(plansRecovery.error, 'helper_conversion_plans'))
      && plansRecovery.error && isMissingSupabaseRelationError(plansRecovery.error, 'helper_conversion_plans')) {
      throw createMissingSupabaseTableError('helper_conversion_plans', plansRecovery.error);
    }
  } catch (err) {
    console.warn('Failed to recover stale helper jobs', err);
  }
}

async function startServer() {
  const bootstrap = await ensureSupabaseSchema('startup');
  if (bootstrap.attempted && !bootstrap.ok && !bootstrap.skipped) {
    console.warn('Supabase helper schema bootstrap failed', bootstrap);
  }
  await recoverStaleJobs();
  const schema = await inspectSupabaseSchema();
  if (!schema.ok) {
    console.warn('Supabase helper schema is incomplete', schema);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`${SERVICE_NAME} ${SERVICE_VERSION} listening on ${PORT}`);
  });
}
