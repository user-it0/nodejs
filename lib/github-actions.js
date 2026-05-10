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

function normalizeBaseUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.replace(/\/+$/, '');
}

const GITHUB_EXECUTION_TOKEN = String(
  process.env.GITHUB_EXECUTION_TOKEN
  || process.env.GH_EXECUTION_TOKEN
  || process.env.GITHUB_TOKEN
  || ''
).trim();

const GITHUB_EXECUTION_REPOSITORY = String(
  process.env.GITHUB_EXECUTION_REPOSITORY
  || process.env.GITHUB_REPOSITORY
  || ''
).trim();

const GITHUB_EXECUTION_WORKFLOW = String(
  process.env.GITHUB_EXECUTION_WORKFLOW
  || process.env.GITHUB_EXECUTION_WORKFLOW_FILE
  || 'ivucx-proof-executor.yml'
).trim();

const GITHUB_EXECUTION_REF = String(
  process.env.GITHUB_EXECUTION_REF
  || process.env.GITHUB_EXECUTION_BRANCH
  || process.env.GITHUB_REF_NAME
  || 'main'
).trim();

const GITHUB_EXECUTION_API_BASE_URL = normalizeBaseUrl(
  process.env.GITHUB_EXECUTION_API_BASE_URL
  || 'https://api.github.com'
);

const GITHUB_EXECUTION_TIMEOUT_MS = Number(process.env.GITHUB_EXECUTION_TIMEOUT_MS || 30000);
const GITHUB_EXECUTION_ENABLE_LEAN_CIC = parseBoolean(
  process.env.GITHUB_EXECUTION_ENABLE_LEAN_CIC
  || process.env.IVUCX_ENABLE_LEAN_CIC
  || process.env.LEAN_CIC_ENABLED,
  false
);
const GITHUB_EXECUTION_ENABLE_COQ_CIC = parseBoolean(
  process.env.GITHUB_EXECUTION_ENABLE_COQ_CIC
  || process.env.IVUCX_ENABLE_COQ_CIC
  || process.env.COQ_CIC_ENABLED,
  false
);

const GITHUB_EXECUTION_ENABLED = parseBoolean(
  process.env.GITHUB_EXECUTION_ENABLED,
  Boolean(GITHUB_EXECUTION_TOKEN && GITHUB_EXECUTION_REPOSITORY && GITHUB_EXECUTION_WORKFLOW)
);

function hasGitHubExecution() {
  return GITHUB_EXECUTION_ENABLED && Boolean(
    GITHUB_EXECUTION_TOKEN
    && GITHUB_EXECUTION_REPOSITORY
    && GITHUB_EXECUTION_WORKFLOW
  );
}

function getGitHubExecutionInfo() {
  return {
    enabled: hasGitHubExecution(),
    repository: GITHUB_EXECUTION_REPOSITORY || null,
    workflow: GITHUB_EXECUTION_WORKFLOW || null,
    ref: GITHUB_EXECUTION_REF || null,
    timeoutMs: GITHUB_EXECUTION_TIMEOUT_MS,
    apiBaseUrl: GITHUB_EXECUTION_API_BASE_URL || null,
    cic: {
      lean: GITHUB_EXECUTION_ENABLE_LEAN_CIC,
      coq: GITHUB_EXECUTION_ENABLE_COQ_CIC
    }
  };
}

function normalizeInputValue(value) {
  return String(value || '').trim().toLowerCase();
}

function shouldEnableCicForDispatch(payload, language) {
  const operation = normalizeInputValue(payload.operation);
  const format = normalizeInputValue(payload.format);
  const normalizedLanguage = normalizeInputValue(language || payload.language);

  return Boolean(
    format === 'cic-v1'
    && (operation === 'convert' || operation === 'submit')
    && normalizedLanguage
  );
}

function createGitHubExecutionConfigurationError() {
  const error = new Error(
    'GitHub Actions execution is not configured. Set GITHUB_EXECUTION_TOKEN, GITHUB_EXECUTION_REPOSITORY, and GITHUB_EXECUTION_WORKFLOW.'
  );
  error.statusCode = 503;
  return error;
}

function createController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

function cleanupTimer(timer) {
  clearTimeout(timer);
}

export function isGitHubExecutionConfigured() {
  return hasGitHubExecution();
}

export function getGitHubExecutionConfig() {
  return getGitHubExecutionInfo();
}

export async function dispatchGitHubExecutionRun(payload) {
  if (!hasGitHubExecution()) {
    throw createGitHubExecutionConfigurationError();
  }

  const { controller, timer } = createController(GITHUB_EXECUTION_TIMEOUT_MS);
  const url = `${GITHUB_EXECUTION_API_BASE_URL}/repos/${GITHUB_EXECUTION_REPOSITORY}/actions/workflows/${encodeURIComponent(GITHUB_EXECUTION_WORKFLOW)}/dispatches`;
  const normalizedLanguage = normalizeInputValue(payload.language);
  const shouldEnableCic = shouldEnableCicForDispatch(payload, normalizedLanguage);
  const enableLeanCic = shouldEnableCic && normalizedLanguage === 'lean' && GITHUB_EXECUTION_ENABLE_LEAN_CIC;
  const enableCoqCic = shouldEnableCic && normalizedLanguage === 'coq' && GITHUB_EXECUTION_ENABLE_COQ_CIC;

  const body = {
    ref: GITHUB_EXECUTION_REF,
    inputs: {
      plan_id: String(payload.planId || ''),
      helper_job_id: String(payload.helperJobId || ''),
      operation: String(payload.operation || ''),
      helper_base_url: String(payload.helperBaseUrl || ''),
      helper_access_token: String(payload.helperAccessToken || ''),
      request_id: String(payload.requestId || ''),
      language: normalizedLanguage,
      enable_lean_cic: enableLeanCic ? 'true' : 'false',
      enable_coq_cic: enableCoqCic ? 'true' : 'false'
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_EXECUTION_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ivucx-github-executor'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const rawText = await response.text();
    cleanupTimer(timer);

    if (response.status === 204) {
      return {
        ok: true,
        status: response.status
      };
    }

    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch (_error) {
      parsed = null;
    }

    const error = new Error(
      (parsed && (parsed.message || parsed.error))
      || rawText
      || `GitHub Actions dispatch failed with ${response.status}`
    );
    error.statusCode = response.status >= 400 ? response.status : 502;
    error.details = {
      repository: GITHUB_EXECUTION_REPOSITORY,
      workflow: GITHUB_EXECUTION_WORKFLOW,
      ref: GITHUB_EXECUTION_REF,
      response: parsed || rawText
    };
    throw error;
  } catch (error) {
    cleanupTimer(timer);
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      const timeoutError = new Error('GitHub Actions dispatch timed out.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  }
}
