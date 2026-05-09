import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { readFile, writeFile, mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(MODULE_DIR, '..');
const TOOLS_DIR = path.join(ROOT_DIR, 'tools');
const OUTPUT_LIMIT = Number(process.env.GITHUB_EXECUTION_OUTPUT_LIMIT || 48000);
const PROCESS_TIMEOUT_MS = Number(process.env.GITHUB_EXECUTION_PROCESS_TIMEOUT_MS || 180000);
const PLAN_ID = String(process.env.PLAN_ID || '').trim();
const HELPER_JOB_ID = String(process.env.HELPER_JOB_ID || '').trim();
const OPERATION = String(process.env.OPERATION || '').trim().toLowerCase();
const HELPER_BASE_URL = String(process.env.HELPER_BASE_URL || '').trim().replace(/\/+$/, '');
const HELPER_ACCESS_TOKEN = String(process.env.HELPER_ACCESS_TOKEN || '').trim();
const HELPER_API_KEY = String(process.env.HELPER_API_KEY || '').trim();
const CALLBACK_ROUTE = String(process.env.HELPER_CALLBACK_ROUTE || '/api/helper/github-actions/callback').trim();

function requireEnv(name, value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function normalizeLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized === 'lean' || normalized === 'coq') {
    return normalized;
  }
  throw new Error('language must be Lean or Coq');
}

function toLabel(language) {
  return normalizeLanguage(language) === 'lean' ? 'Lean' : 'Coq';
}

function defaultFileName(language) {
  return normalizeLanguage(language) === 'lean' ? 'Main.lean' : 'Main.v';
}

function truncateOutput(value) {
  const text = String(value || '');
  if (text.length <= OUTPUT_LIMIT) {
    return text;
  }
  return `${text.slice(0, OUTPUT_LIMIT)}\n...[truncated]`;
}

function sha256(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function splitArgs(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < rawValue.length; index += 1) {
    const char = rawValue[index];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && index + 1 < rawValue.length) {
        index += 1;
        current += rawValue[index];
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function tryParseJson(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
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
    || normalized.includes('no external coq cic exporter is configured')
  );
}

function getWorkflowMeta() {
  return {
    runId: String(process.env.GITHUB_RUN_ID || '').trim() || null,
    runAttempt: String(process.env.GITHUB_RUN_ATTEMPT || '').trim() || null,
    repository: String(process.env.GITHUB_REPOSITORY || '').trim() || null,
    sha: String(process.env.GITHUB_SHA || '').trim() || null,
    workflow: String(process.env.GITHUB_WORKFLOW || '').trim() || null
  };
}

function getSupabaseClient() {
  const url = requireEnv(
    'NEXT_PUBLIC_SUPABASE_URL',
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  );
  const key = requireEnv(
    'SUPABASE_SERVICE_ROLE_KEY',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function createHelperHeaders() {
  if (HELPER_ACCESS_TOKEN) {
    return {
      Accept: 'application/json',
      'X-Ivucx-Execution-Token': HELPER_ACCESS_TOKEN
    };
  }

  const headers = {
    Accept: 'application/json'
  };

  if (HELPER_API_KEY) {
    headers.Authorization = `Bearer ${HELPER_API_KEY}`;
    headers['X-Helper-Key'] = HELPER_API_KEY;
  }

  return headers;
}

async function loadPlanFromHelper(planId) {
  const helperBaseUrl = requireEnv('HELPER_BASE_URL', HELPER_BASE_URL);
  const url = `${helperBaseUrl}/api/helper/plans/${encodeURIComponent(planId)}/execution`;
  const response = await fetch(url, {
    method: 'GET',
    headers: createHelperHeaders()
  });

  const text = await response.text();
  const parsed = tryParseJson(text);

  if (!response.ok) {
    throw new Error(
      (parsed && (parsed.error || parsed.message))
      || text
      || `Helper plan fetch failed with ${response.status}`
    );
  }

  const plan = parsed && parsed.plan && typeof parsed.plan === 'object'
    ? parsed.plan
    : null;
  if (!plan) {
    throw new Error('Helper plan fetch did not return a plan payload.');
  }
  return plan;
}

async function loadPlan(client, planId) {
  const { data, error } = await client
    .from('helper_conversion_plans')
    .select('*')
    .eq('id', planId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || 'Failed to load helper_conversion_plans row.');
  }
  if (!data) {
    throw new Error(`Conversion plan ${planId} was not found.`);
  }

  return {
    id: data.id,
    helperJobId: data.helper_job_id || HELPER_JOB_ID,
    operation: String(data.operation || OPERATION || 'convert').trim().toLowerCase(),
    title: data.title || '',
    language: toLabel(data.language || 'Lean'),
    fileName: data.file_name || defaultFileName(data.language || 'Lean'),
    requestedFormat: data.requested_format || 'typed-lambda-v1',
    verify: data.verify !== false,
    sourceCode: data.source_code || '',
    sourceSha256: data.source_sha256 || sha256(data.source_code || '')
  };
}

async function loadPlanForExecution(planId) {
  if (HELPER_BASE_URL && (HELPER_ACCESS_TOKEN || HELPER_API_KEY)) {
    return loadPlanFromHelper(planId);
  }

  const client = getSupabaseClient();
  return loadPlan(client, planId);
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs || PROCESS_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        command,
        args,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr
      });
    });
  });
}

async function runProofCheck(language, code, fileName) {
  const normalizedLanguage = normalizeLanguage(language);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `ivucx-proof-${normalizedLanguage}-`));
  const safeFileName = path.basename(String(fileName || defaultFileName(normalizedLanguage)));
  const sourcePath = path.join(tempDir, safeFileName);
  const codeText = String(code || '');
  const codeBytes = Buffer.byteLength(codeText, 'utf8');

  try {
    await writeFile(sourcePath, codeText, 'utf8');

    const command = normalizedLanguage === 'lean'
      ? String(process.env.IVUCX_LEAN_CMD || process.env.LEAN_CMD || 'lean').trim()
      : String(process.env.IVUCX_COQ_CMD || process.env.COQ_CMD || 'coqc').trim();
    const rawArgs = normalizedLanguage === 'lean'
      ? String(process.env.IVUCX_LEAN_ARGS || process.env.LEAN_ARGS || '').trim()
      : String(process.env.IVUCX_COQ_ARGS || process.env.COQ_ARGS || '').trim();
    const args = [...splitArgs(rawArgs), sourcePath];
    const result = await runProcess(command, args, {
      cwd: tempDir,
      timeoutMs: Number(process.env.GITHUB_EXECUTION_PROOF_TIMEOUT_MS || PROCESS_TIMEOUT_MS)
    });

    const ok = result.exitCode === 0 && !result.timedOut;
    return {
      ok,
      language: normalizedLanguage,
      fileName: safeFileName,
      command,
      args,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      codeBytes,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
      error: ok ? '' : truncateOutput(result.stderr || result.stdout || `${toLabel(normalizedLanguage)} proof check failed`),
      source: 'github-actions'
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function getToolPath(language, format) {
  const normalizedLanguage = normalizeLanguage(language);
  const normalizedFormat = String(format || '').trim().toLowerCase();

  if (normalizedLanguage === 'lean') {
    return normalizedFormat === 'cic-v1'
      ? path.join(TOOLS_DIR, 'convert-lean-cic.cjs')
      : path.join(TOOLS_DIR, 'convert-lean.cjs');
  }

  return normalizedFormat === 'cic-v1'
    ? path.join(TOOLS_DIR, 'convert-coq-cic.cjs')
    : path.join(TOOLS_DIR, 'convert-coq.cjs');
}

async function runConversion(language, code, fileName, format) {
  const normalizedLanguage = normalizeLanguage(language);
  const requestedFormat = String(format || '').trim() || 'typed-lambda-v1';
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `ivucx-convert-${normalizedLanguage}-`));
  const safeFileName = path.basename(String(fileName || defaultFileName(normalizedLanguage)));
  const sourcePath = path.join(tempDir, safeFileName);
  const outputPath = path.join(tempDir, 'result.json');
  const codeText = String(code || '');
  const codeBytes = Buffer.byteLength(codeText, 'utf8');
  const codeHash = sha256(codeText);

  try {
    await writeFile(sourcePath, codeText, 'utf8');

    const toolPath = getToolPath(normalizedLanguage, requestedFormat);
    const args = [toolPath, '--out', outputPath, sourcePath];
    const result = await runProcess(process.execPath, args, {
      cwd: ROOT_DIR,
      timeoutMs: Number(process.env.GITHUB_EXECUTION_CONVERSION_TIMEOUT_MS || PROCESS_TIMEOUT_MS)
    });

    const rawOutput = await readFile(outputPath, 'utf8').catch(() => '');
    const structured = tryParseJson(rawOutput);
    const ok = result.exitCode === 0 && !result.timedOut && structured && !structured.error;
    const targetFamily = String(requestedFormat).trim().toLowerCase() === 'cic-v1' ? 'cic' : 'typed-lambda';
    const lambdaPayload = structured && !structured.error
      ? structured
      : {
        format: requestedFormat,
        error: structured && structured.error
          ? String(structured.error)
          : truncateOutput(result.stderr || result.stdout || `${toLabel(normalizedLanguage)} conversion failed`)
      };

    return {
      ok,
      language: normalizedLanguage,
      targetFamily,
      requestedFormat,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      codeBytes,
      codeHash,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
      lambda: lambdaPayload
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function extractConversionMessage(result) {
  if (!result || typeof result !== 'object') {
    return 'Conversion failed.';
  }

  if (result.conversion && typeof result.conversion === 'object') {
    const conversion = result.conversion;
    if (conversion.lambda && typeof conversion.lambda === 'object' && typeof conversion.lambda.error === 'string' && conversion.lambda.error.trim()) {
      return conversion.lambda.error.trim();
    }
    if (typeof conversion.stderr === 'string' && conversion.stderr.trim()) {
      return conversion.stderr.trim();
    }
    if (typeof conversion.stdout === 'string' && conversion.stdout.trim()) {
      return conversion.stdout.trim();
    }
  }

  if (typeof result.error === 'string' && result.error.trim()) {
    return result.error.trim();
  }

  return 'Conversion failed.';
}

function summarizeConversionFailure(result) {
  const conversion = result && result.conversion && typeof result.conversion === 'object'
    ? result.conversion
    : null;
  const lambda = conversion && conversion.lambda && typeof conversion.lambda === 'object'
    ? conversion.lambda
    : null;

  return {
    requestedFormat: conversion && conversion.requestedFormat ? conversion.requestedFormat : null,
    targetFamily: conversion && conversion.targetFamily ? conversion.targetFamily : null,
    exitCode: conversion && typeof conversion.exitCode === 'number' ? conversion.exitCode : null,
    timedOut: Boolean(conversion && conversion.timedOut),
    error: extractConversionMessage(result),
    stdout: truncateOutput(conversion && conversion.stdout ? conversion.stdout : ''),
    stderr: truncateOutput(conversion && conversion.stderr ? conversion.stderr : ''),
    lambdaError: lambda && typeof lambda.error === 'string' ? truncateOutput(lambda.error) : ''
  };
}

async function performConversion(plan, formatOverride = '') {
  const completedFormat = String(formatOverride || '').trim() || plan.requestedFormat;
  const verifyBeforeConvert = plan.verify !== false;
  let proofCheck = null;

  if (verifyBeforeConvert) {
    proofCheck = await runProofCheck(plan.language, plan.sourceCode, plan.fileName);
    if (!proofCheck.ok) {
      return {
        result: {
          ok: false,
          stage: 'proof-check',
          timedOut: proofCheck.timedOut,
          httpStatus: proofCheck.timedOut ? 504 : 422,
          language: normalizeLanguage(plan.language),
          verifyBeforeConvert,
          proofCheck,
          conversion: null
        },
        completedFormat,
        fallbackUsed: false
      };
    }
  }

  const conversion = await runConversion(plan.language, plan.sourceCode, plan.fileName, completedFormat);
  const result = conversion.ok
    ? {
      ok: true,
      stage: 'completed',
      timedOut: false,
      language: normalizeLanguage(plan.language),
      verifyBeforeConvert,
      proofCheck,
      conversion
    }
    : {
      ok: false,
      stage: 'conversion',
      timedOut: conversion.timedOut,
      httpStatus: conversion.timedOut ? 504 : 422,
      language: normalizeLanguage(plan.language),
      verifyBeforeConvert,
      proofCheck,
      conversion
    };

  if (!result.ok && shouldRetryWithTypedLambda(plan.requestedFormat, extractConversionMessage(result))) {
    const fallbackReason = summarizeConversionFailure(result);
    console.warn(`CIC conversion failed; retrying typed-lambda-v1 fallback: ${fallbackReason.error}`);
    const fallback = await runConversion(plan.language, plan.sourceCode, plan.fileName, 'typed-lambda-v1');
    return {
      result: fallback.ok
        ? {
          ok: true,
          stage: 'completed',
          timedOut: false,
          language: normalizeLanguage(plan.language),
          verifyBeforeConvert,
          proofCheck,
          conversion: fallback
        }
        : {
          ok: false,
          stage: 'conversion',
          timedOut: fallback.timedOut,
          httpStatus: fallback.timedOut ? 504 : 422,
          language: normalizeLanguage(plan.language),
          verifyBeforeConvert,
          proofCheck,
          conversion: fallback
        },
      completedFormat: 'typed-lambda-v1',
      fallbackUsed: true,
      fallback: fallbackReason
    };
  }

  return {
    result,
    completedFormat,
    fallbackUsed: false
  };
}

async function postCallback(body) {
  const helperBaseUrl = requireEnv('HELPER_BASE_URL', HELPER_BASE_URL);
  const url = `${helperBaseUrl}${CALLBACK_ROUTE}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...createHelperHeaders()
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Helper callback failed with ${response.status}`);
  }
}

async function main() {
  requireEnv('PLAN_ID', PLAN_ID);
  requireEnv('HELPER_JOB_ID', HELPER_JOB_ID);
  requireEnv('OPERATION', OPERATION);

  const plan = await loadPlanForExecution(PLAN_ID);
  const workflow = getWorkflowMeta();

  if (plan.operation === 'check') {
    const verification = await runProofCheck(plan.language, plan.sourceCode, plan.fileName);
    await postCallback({
      planId: plan.id,
      helperJobId: plan.helperJobId || HELPER_JOB_ID,
      operation: plan.operation,
      verification,
      result: {
        ok: Boolean(verification.ok),
        verification
      },
      workflow
    });
    return;
  }

  const execution = await performConversion(plan);
  await postCallback({
    planId: plan.id,
    helperJobId: plan.helperJobId || HELPER_JOB_ID,
    operation: plan.operation,
    result: execution.result,
    completedFormat: execution.completedFormat,
    fallbackUsed: execution.fallbackUsed,
    fallback: execution.fallback || null,
    workflow
  });
}

main().catch(async (error) => {
  const callbackBody = {
    planId: PLAN_ID || null,
    helperJobId: HELPER_JOB_ID || null,
    operation: OPERATION || null,
    error: {
      message: error && error.message ? error.message : 'GitHub Actions worker failed'
    },
    workflow: getWorkflowMeta()
  };

  try {
    if (PLAN_ID && HELPER_JOB_ID && OPERATION) {
      await postCallback(callbackBody);
    }
  } catch (callbackError) {
    console.error('[github-execution-worker] callback failed', callbackError);
  }

  console.error('[github-execution-worker] execution failed', error);
  process.exitCode = 1;
});
