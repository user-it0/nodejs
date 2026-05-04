const { createHash } = require('node:crypto');
const config = require('./config');
const { CIC_SCHEMA_VERSION, normalizeCicExport } = require('./cic-normalizer.cjs');
const { runCommandForCode, truncateOutput } = require('./runner');

function normalizeLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized === 'lean' || normalized === 'coq') {
    return normalized;
  }

  const error = new Error('language must be Lean or Coq');
  error.statusCode = 400;
  throw error;
}

function getConverterInfo() {
  return {
    typedLambda: {
      lean: {
        available: Boolean(config.converters.lean.command),
        command: config.converters.lean.command,
        args: config.converters.lean.args,
        stdoutFormat: config.converters.lean.stdoutFormat,
        resultFormat: config.converters.lean.resultFormat,
        extension: config.converters.lean.extension
      },
      coq: {
        available: Boolean(config.converters.coq.command),
        command: config.converters.coq.command,
        args: config.converters.coq.args,
        stdoutFormat: config.converters.coq.stdoutFormat,
        resultFormat: config.converters.coq.resultFormat,
        extension: config.converters.coq.extension
      }
    },
    cic: {
      lean: {
        available: Boolean(config.cicConverters.lean.command),
        command: config.cicConverters.lean.command || null,
        args: config.cicConverters.lean.args,
        stdoutFormat: config.cicConverters.lean.stdoutFormat,
        resultFormat: config.cicConverters.lean.resultFormat,
        schemaVersion: CIC_SCHEMA_VERSION,
        extension: config.cicConverters.lean.extension
      },
      coq: {
        available: Boolean(config.cicConverters.coq.command),
        command: config.cicConverters.coq.command || null,
        args: config.cicConverters.coq.args,
        stdoutFormat: config.cicConverters.coq.stdoutFormat,
        resultFormat: config.cicConverters.coq.resultFormat,
        schemaVersion: CIC_SCHEMA_VERSION,
        extension: config.cicConverters.coq.extension
      }
    }
  };
}

function normalizeRequestedFormat(format) {
  return String(format || '').trim().toLowerCase();
}

function resolveConverter(normalizedLanguage, requestedFormat) {
  const normalizedFormat = normalizeRequestedFormat(requestedFormat);
  if (normalizedFormat === 'cic' || normalizedFormat === 'cic-v1') {
    const converter = config.cicConverters[normalizedLanguage];
    if (!converter || !converter.command) {
      const error = new Error(`${normalizedLanguage} CIC converter is not configured`);
      error.statusCode = 503;
      throw error;
    }
    return {
      family: 'cic',
      converter
    };
  }

  const converter = config.converters[normalizedLanguage];
  if (!converter || !converter.command) {
    const error = new Error(`${normalizedLanguage} lambda converter is not configured`);
    error.statusCode = 503;
    throw error;
  }

  return {
    family: 'typed-lambda',
    converter
  };
}

function normalizeLambdaPayload(structured, fallbackText, fallbackFormat, options = {}) {
  if (structured && typeof structured === 'object' && !Array.isArray(structured) && typeof structured.error === 'string') {
    return {
      format: structured.format || fallbackFormat || 'typed-lambda-v1',
      error: structured.error,
      details: structured.details || null,
      rawText: typeof fallbackText === 'string' ? fallbackText : ''
    };
  }

  const normalizedFormat = normalizeRequestedFormat((structured && structured.format) || fallbackFormat);

  if (normalizedFormat === 'cic' || normalizedFormat === 'cic-v1') {
    if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
      return {
        ...normalizeCicExport(structured, {
          sourceLanguage: options.sourceLanguage || null,
          sourceEncoding: structured.metadata && structured.metadata.extraction
            ? structured.metadata.extraction
            : 'unknown',
          theoremName: structured.theoremName || structured.name || options.defaultTheoremName || 'Main'
        }),
        rawText: typeof fallbackText === 'string' ? fallbackText : ''
      };
    }

    return {
      ...normalizeCicExport({
        theoremName: options.defaultTheoremName || 'Main',
        term: null,
        context: null,
        declarations: null,
        metadata: {
          sourceLanguage: options.sourceLanguage || 'unknown',
          extraction: 'invalid-cic-payload'
        }
      }, {
        sourceLanguage: options.sourceLanguage || 'unknown',
        sourceEncoding: 'invalid-cic-payload',
        theoremName: options.defaultTheoremName || 'Main'
      }),
      rawText: typeof fallbackText === 'string' ? fallbackText : ''
    };
  }

  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const term = structured.term || structured.lambda || structured.expression || structured.normalized || structured.ast || structured;

    return {
      format: structured.format || fallbackFormat || 'typed-lambda-v1',
      term,
      context: structured.context || structured.ctx || null,
      declarations: structured.declarations || null,
      metadata: structured.metadata || null,
      rawText: typeof fallbackText === 'string' ? fallbackText : ''
    };
  }

  return {
    format: fallbackFormat || 'typed-lambda-v1',
    term: typeof fallbackText === 'string' ? fallbackText.trim() : '',
    context: null,
    declarations: null,
    metadata: null,
      rawText: typeof fallbackText === 'string' ? fallbackText : ''
  };
}

async function runLambdaConversion(payload) {
  const normalizedLanguage = normalizeLanguage(payload && payload.language);
  const resolved = resolveConverter(normalizedLanguage, payload && payload.format);
  const converter = resolved.converter;
  const normalizedCode = payload && typeof payload.code === 'string' ? payload.code : '';

  const execution = await runCommandForCode({
    command: converter.command,
    args: converter.args,
    code: normalizedCode,
    fileName: payload && payload.fileName,
    defaultFileName: converter.defaultFileName,
    extension: converter.extension,
    timeoutMs: config.processTimeoutMs,
    tempPrefix: `lambda-${normalizedLanguage}-`
  });

  const rawOutput = execution.outputText || execution.stdout;
  let structured = null;

  if (converter.stdoutFormat === 'json' && rawOutput) {
    try {
      structured = JSON.parse(rawOutput);
    } catch (error) {
      if (execution.ok) {
        const parseError = new Error(`${normalizedLanguage} lambda converter returned invalid JSON`);
        parseError.statusCode = 502;
        parseError.details = {
          stdout: truncateOutput(execution.stdout),
          stderr: truncateOutput(execution.stderr)
        };
        throw parseError;
      }
    }
  }

  return {
    ok: execution.ok,
    language: normalizedLanguage,
    targetFamily: resolved.family,
    requestedFormat: payload && payload.format ? payload.format : null,
    fileName: execution.fileName,
    command: execution.command,
    args: execution.args,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs,
    codeBytes: execution.codeBytes,
    codeHash: createHash('sha256').update(normalizedCode, 'utf8').digest('hex'),
    stdout: truncateOutput(execution.stdout),
    stderr: truncateOutput(execution.stderr),
    lambda: normalizeLambdaPayload(structured, rawOutput, payload && payload.format ? payload.format : converter.resultFormat, {
      sourceLanguage: normalizedLanguage === 'lean' ? 'Lean' : 'Coq',
      defaultTheoremName: execution.fileName ? execution.fileName.replace(/\.[^.]+$/, '') : 'Main'
    })
  };
}

module.exports = {
  getConverterInfo,
  runLambdaConversion
};
