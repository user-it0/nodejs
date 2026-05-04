#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeCicExport } = require('../lib/cic-normalizer.cjs');
const {
  buildError,
  parseCliArgs,
  runProcess,
  writeJson
} = require('./export-utils.cjs');

function splitArgs(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < rawValue.length; i += 1) {
    const ch = rawValue[i];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && i + 1 < rawValue.length) {
        i += 1;
        current += rawValue[i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function stripLeanCommentsAndStrings(source) {
  let output = '';
  let index = 0;
  let blockDepth = 0;
  let inLineComment = false;
  let inString = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1] || '';

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      index += 1;
      continue;
    }

    if (blockDepth > 0) {
      if (current === '/' && next === '-') {
        blockDepth += 1;
        output += '  ';
        index += 2;
        continue;
      }
      if (current === '-' && next === '/') {
        blockDepth -= 1;
        output += '  ';
        index += 2;
        continue;
      }
      output += current === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (inString) {
      if (current === '"' && source[index - 1] !== '\\') {
        inString = false;
      }
      output += current === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    if (current === '-' && next === '-') {
      inLineComment = true;
      output += '  ';
      index += 2;
      continue;
    }

    if (current === '/' && next === '-') {
      blockDepth = 1;
      output += '  ';
      index += 2;
      continue;
    }

    if (current === '"') {
      inString = true;
      output += ' ';
      index += 1;
      continue;
    }

    output += current;
    index += 1;
  }

  return output;
}

function popStack(stack, name) {
  if (!stack.length) {
    return;
  }

  if (!name) {
    stack.pop();
    return;
  }

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index];
    const fullName = entry.parts.join('.');
    if (entry.rawName === name || fullName === name || entry.parts[entry.parts.length - 1] === name) {
      stack.splice(index, 1);
      return;
    }
  }

  stack.pop();
}

function detectLeanDeclarations(source) {
  const cleaned = stripLeanCommentsAndStrings(source);
  const lines = cleaned.split(/\r?\n/);
  const namespaceStack = [];
  const declarations = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const namespaceMatch = trimmed.match(/^namespace\s+([A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*)\b/);
    if (namespaceMatch) {
      namespaceStack.push({ rawName: namespaceMatch[1], parts: namespaceMatch[1].split('.') });
      continue;
    }

    const sectionMatch = trimmed.match(/^section(?:\s+([A-Za-z_][A-Za-z0-9_']*))?\b/);
    if (sectionMatch) {
      namespaceStack.push({ rawName: sectionMatch[1] || '', parts: [] });
      continue;
    }

    const endMatch = trimmed.match(/^end(?:\s+([A-Za-z_][A-Za-z0-9_'.]*))?\b/);
    if (endMatch) {
      popStack(namespaceStack, endMatch[1] || '');
      continue;
    }

    const declarationMatch = trimmed.match(/^(?:@[A-Za-z0-9_.]+\s+)*(?:(?:private|protected|noncomputable|unsafe|partial|local|scoped)\s+)*(theorem|lemma|def|abbrev|opaque)\s+([A-Za-z_][A-Za-z0-9_']*)\b/);
    if (!declarationMatch) {
      continue;
    }

    const namespaceParts = namespaceStack
      .filter((entry) => Array.isArray(entry.parts) && entry.parts.length > 0)
      .flatMap((entry) => entry.parts);

    declarations.push({
      kind: declarationMatch[1],
      name: declarationMatch[2],
      fullName: namespaceParts.length ? `${namespaceParts.join('.')}.${declarationMatch[2]}` : declarationMatch[2]
    });
  }

  return declarations;
}

function parseNdjson(input) {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildExportState(lines) {
  const state = {
    meta: null,
    names: new Map(),
    levels: new Map(),
    exprs: new Map(),
    decls: []
  };

  for (const line of lines) {
    if (line.meta) {
      state.meta = line.meta;
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(line, 'in') && (line.str || line.num)) {
      state.names.set(line.in, line);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(line, 'il')) {
      state.levels.set(line.il, line);
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(line, 'ie')) {
      state.exprs.set(line.ie, line);
      continue;
    }

    const kind = ['axiom', 'def', 'opaque', 'thm', 'quot', 'inductive'].find((key) => line[key]);
    if (kind) {
      state.decls.push({ kind, payload: line[kind] });
    }
  }

  return state;
}

function createDecoders(state) {
  const nameCache = new Map();
  const levelCache = new Map();
  const exprCache = new Map();

  function decodeName(id) {
    if (!Number.isInteger(id) || id <= 0) {
      return '';
    }
    if (nameCache.has(id)) {
      return nameCache.get(id);
    }

    const entry = state.names.get(id);
    if (!entry) {
      return '';
    }

    let value = '';
    if (entry.str) {
      const prefix = decodeName(entry.str.pre);
      value = prefix ? `${prefix}.${entry.str.str}` : entry.str.str;
    } else if (entry.num) {
      const prefix = decodeName(entry.num.pre);
      value = prefix ? `${prefix}.${entry.num.i}` : String(entry.num.i);
    }

    nameCache.set(id, value);
    return value;
  }

  function decodeLevel(id) {
    if (!Number.isInteger(id)) {
      return null;
    }
    if (levelCache.has(id)) {
      return levelCache.get(id);
    }

    const entry = state.levels.get(id);
    if (!entry) {
      return { kind: 'level-ref', id };
    }

    let value;
    if (Object.prototype.hasOwnProperty.call(entry, 'succ')) {
      value = { kind: 'succ', of: decodeLevel(entry.succ) };
    } else if (entry.max) {
      value = { kind: 'max', values: entry.max.map(decodeLevel) };
    } else if (entry.imax) {
      value = { kind: 'imax', values: entry.imax.map(decodeLevel) };
    } else if (Object.prototype.hasOwnProperty.call(entry, 'param')) {
      value = { kind: 'param', name: decodeName(entry.param) };
    } else {
      value = { kind: 'level-raw', value: entry };
    }

    levelCache.set(id, value);
    return value;
  }

  function decodeExpr(id) {
    if (!Number.isInteger(id)) {
      return null;
    }
    if (exprCache.has(id)) {
      return exprCache.get(id);
    }

    const entry = state.exprs.get(id);
    if (!entry) {
      return { kind: 'expr-ref', id };
    }

    let value;
    if (Object.prototype.hasOwnProperty.call(entry, 'bvar')) {
      value = { kind: 'rel', index: entry.bvar };
    } else if (Object.prototype.hasOwnProperty.call(entry, 'sort')) {
      value = { kind: 'sort', level: decodeLevel(entry.sort) };
    } else if (entry.const) {
      value = {
        kind: 'const',
        name: decodeName(entry.const.name),
        universes: Array.isArray(entry.const.us) ? entry.const.us.map(decodeLevel) : []
      };
    } else if (entry.app) {
      const spine = [];
      let currentFnId = entry.app.fn;
      let current = state.exprs.get(currentFnId);

      while (current && current.app) {
        spine.push(decodeExpr(current.app.arg));
        currentFnId = current.app.fn;
        current = state.exprs.get(currentFnId);
      }

      value = {
        kind: 'app',
        fn: decodeExpr(currentFnId),
        args: spine.reverse()
      };
    } else if (entry.lam) {
      value = {
        kind: 'lambda',
        name: decodeName(entry.lam.name) || '_',
        binderInfo: entry.lam.binderInfo || 'default',
        type: decodeExpr(entry.lam.type),
        body: decodeExpr(entry.lam.body)
      };
    } else if (entry.forallE) {
      value = {
        kind: 'prod',
        name: decodeName(entry.forallE.name) || '_',
        binderInfo: entry.forallE.binderInfo || 'default',
        type: decodeExpr(entry.forallE.type),
        body: decodeExpr(entry.forallE.body)
      };
    } else if (entry.letE) {
      value = {
        kind: 'let',
        name: decodeName(entry.letE.name) || '_',
        type: decodeExpr(entry.letE.type),
        value: decodeExpr(entry.letE.value),
        body: decodeExpr(entry.letE.body),
        nondep: !!entry.letE.nondep
      };
    } else if (entry.proj) {
      value = {
        kind: 'proj',
        typeName: decodeName(entry.proj.typeName),
        index: entry.proj.idx,
        struct: decodeExpr(entry.proj.struct)
      };
    } else if (Object.prototype.hasOwnProperty.call(entry, 'natVal')) {
      value = { kind: 'lit', literal: 'nat', value: entry.natVal };
    } else if (Object.prototype.hasOwnProperty.call(entry, 'strVal')) {
      value = { kind: 'lit', literal: 'string', value: entry.strVal };
    } else if (entry.mdata) {
      value = decodeExpr(entry.mdata.expr);
    } else {
      value = { kind: 'expr-raw', value: entry };
    }

    exprCache.set(id, value);
    return value;
  }

  return {
    decodeExpr,
    decodeLevel,
    decodeName
  };
}

function findTargetDeclaration(state, decoders, moduleName, target) {
  const candidates = new Set([
    target.fullName,
    target.name,
    `${moduleName}.${target.fullName}`,
    `${moduleName}.${target.name}`
  ]);

  return state.decls.find((decl) => {
    const name = decoders.decodeName(decl.payload.name);
    if (!name) {
      return false;
    }
    if (candidates.has(name)) {
      return true;
    }
    return Array.from(candidates).some((candidate) => candidate && name.endsWith(`.${candidate}`));
  }) || null;
}

function containsUnsupportedLeanFeature(expr) {
  if (!expr || typeof expr !== 'object') {
    return false;
  }

  if (expr.kind === 'const') {
    return expr.name === 'Quot' || expr.name.startsWith('Quot.');
  }

  return Object.values(expr).some((value) => {
    if (Array.isArray(value)) {
      return value.some(containsUnsupportedLeanFeature);
    }
    return containsUnsupportedLeanFeature(value);
  });
}

async function runLean4Export(sourcePath, moduleName) {
  const dir = path.dirname(sourcePath);
  const lakefileTomlPath = path.join(dir, 'lakefile.toml');
  const toolchainPath = path.join(dir, 'lean-toolchain');
  const command = String(process.env.IVUCX_LEAN_EXPORTER_CMD || process.env.LEAN4EXPORT_CMD || 'lake').trim();
  const exportBin = String(process.env.IVUCX_LEAN_EXPORTER_BIN || process.env.LEAN4EXPORT_BIN || 'lean4export').trim();
  const rawArgs = String(process.env.IVUCX_LEAN_EXPORTER_ARGS || process.env.LEAN4EXPORT_ARGS || 'env {bin} {module}').trim();
  const args = splitArgs(rawArgs || '{module}').map((arg) => arg
    .replaceAll('{bin}', exportBin)
    .replaceAll('{module}', moduleName)
    .replaceAll('{file}', sourcePath)
    .replaceAll('{dir}', dir));

  await fs.writeFile(lakefileTomlPath, 'name = "ivucx_tmp"\n', 'utf8');
  await fs.writeFile(toolchainPath, `${process.env.LEAN_TOOLCHAIN || 'leanprover/lean4:stable'}\n`, 'utf8');

  const env = {
    ...process.env,
    LEAN_PATH: [dir, process.env.LEAN_PATH || ''].filter(Boolean).join(path.delimiter)
  };

  const result = await runProcess(command, args, {
    cwd: dir,
    env,
    timeoutMs: Number(process.env.IVUCX_CONVERTER_TIMEOUT_MS || 180000)
  });

  if (result.timedOut) {
    throw buildError('Lean CIC exporter timed out', result);
  }
  if (result.exitCode !== 0) {
    throw buildError('Lean CIC exporter failed', result);
  }

  return {
    command,
    args,
    stdout: result.stdout
  };
}

async function main() {
  const { flags, positional } = parseCliArgs(process.argv.slice(2));
  const sourcePath = positional[0];
  const outPath = flags.out;

  if (!sourcePath || !outPath) {
    throw buildError('Usage: convert-lean-cic.cjs --out <path> <source-file>');
  }

  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const declarations = detectLeanDeclarations(sourceText);
  const target = declarations[declarations.length - 1];

  if (!target) {
    throw buildError('Could not find a named Lean declaration for CIC export', {
      supported: ['theorem', 'lemma', 'def', 'abbrev', 'opaque']
    });
  }

  const moduleName = path.parse(sourcePath).name;
  const exportResult = await runLean4Export(sourcePath, moduleName);
  const lines = parseNdjson(exportResult.stdout);
  const state = buildExportState(lines);
  const decoders = createDecoders(state);
  const declaration = findTargetDeclaration(state, decoders, moduleName, target);

  if (!declaration) {
    throw buildError('Lean CIC exporter could not find the target declaration in exported NDJSON', {
      target,
      moduleName
    });
  }

  if (declaration.kind === 'quot') {
    throw buildError('Lean CIC exporter cannot encode quotient declarations into plain cic-v1 exactly');
  }

  const theoremName = decoders.decodeName(declaration.payload.name) || target.fullName || target.name;
  const typeExpr = decoders.decodeExpr(declaration.payload.type);
  const valueExpr = Object.prototype.hasOwnProperty.call(declaration.payload, 'value')
    ? decoders.decodeExpr(declaration.payload.value)
    : null;

  if (containsUnsupportedLeanFeature(typeExpr) || containsUnsupportedLeanFeature(valueExpr)) {
    throw buildError('Lean CIC exporter detected quotient-based features that are outside the current cic-v1 fragment');
  }

  await writeJson(outPath, normalizeCicExport({
    theoremName,
    term: valueExpr,
    context: {
      type: typeExpr
    },
    declarations: null,
    metadata: {
      sourceLanguage: 'Lean',
      declarationKind: declaration.kind,
      extraction: 'lean4export-ndjson',
      moduleName,
      exporter: {
        command: exportResult.command,
        args: exportResult.args
      },
      meta: state.meta || null,
      exactFragment: 'quotient-free'
    }
  }, {
    sourceLanguage: 'Lean',
    sourceEncoding: 'lean4export-ndjson',
    theoremName
  }));
}

main().catch(async (error) => {
  const details = error && error.details ? error.details : null;
  await writeJson(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(process.cwd(), 'result.out'), {
    error: error && error.message ? error.message : 'Lean CIC converter failed',
    details
  });
  process.exit(1);
});
