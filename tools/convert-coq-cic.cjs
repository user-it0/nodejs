#!/usr/bin/env node
const fs = require('node:fs/promises');
const os = require('node:os');
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

function resolveOutPath(argv, fallback) {
  const outIndex = argv.indexOf('--out');
  if (outIndex >= 0 && argv[outIndex + 1]) {
    return argv[outIndex + 1];
  }
  return fallback;
}

function stripCoqCommentsAndStrings(source) {
  let output = '';
  let index = 0;
  let blockDepth = 0;
  let inString = false;

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1] || '';

    if (blockDepth > 0) {
      if (current === '(' && next === '*') {
        blockDepth += 1;
        output += '  ';
        index += 2;
        continue;
      }
      if (current === '*' && next === ')') {
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

    if (current === '(' && next === '*') {
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
    if (entry === name) {
      stack.splice(index, 1);
      return;
    }
  }

  stack.pop();
}

function detectCoqDeclarations(source) {
  const cleaned = stripCoqCommentsAndStrings(source);
  const lines = cleaned.split(/\r?\n/);
  const moduleStack = [];
  const declarations = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const moduleMatch = trimmed.match(/^Module(?:\s+Type)?\s+([A-Za-z_][A-Za-z0-9_']*)\b/);
    if (moduleMatch) {
      moduleStack.push(moduleMatch[1]);
      continue;
    }

    const endMatch = trimmed.match(/^End\s+([A-Za-z_][A-Za-z0-9_']*)\s*\./);
    if (endMatch) {
      popStack(moduleStack, endMatch[1]);
      continue;
    }

    const declarationMatch = trimmed.match(/^(?:Local\s+|Global\s+|Program\s+|Polymorphic\s+|Monomorphic\s+|Cumulative\s+|NonCumulative\s+)*(Theorem|Lemma|Fact|Remark|Corollary|Proposition|Definition|Fixpoint|Let)\s+([A-Za-z_][A-Za-z0-9_']*)\b/);
    if (!declarationMatch) {
      continue;
    }

    const name = declarationMatch[2];
    declarations.push({
      kind: declarationMatch[1],
      name,
      fullName: moduleStack.length ? `${moduleStack.join('.')}.${name}` : name
    });
  }

  return declarations;
}

function toCoqStringLiteral(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function runExternalCoqExporter(sourcePath, outPath) {
  const command = String(process.env.IVUCX_COQ_CIC_EXPORT_CMD || process.env.COQ_CIC_EXPORT_CMD || '').trim();
  const rawArgs = String(process.env.IVUCX_COQ_CIC_EXPORT_ARGS || process.env.COQ_CIC_EXPORT_ARGS || '').trim();

  if (!command) {
    throw buildError('No external Coq CIC exporter is configured');
  }

  const tempOutput = path.join(path.dirname(sourcePath), 'coq-cic-export.json');
  const parsedArgs = splitArgs(rawArgs);
  const args = parsedArgs.map((arg) => arg
    .replaceAll('{file}', sourcePath)
    .replaceAll('{out}', tempOutput)
    .replaceAll('{dir}', path.dirname(sourcePath))
    .replaceAll('{name}', path.basename(sourcePath)));

  if (!parsedArgs.some((arg) => String(arg).includes('{file}'))) {
    args.push(sourcePath);
  }

  const result = await runProcess(command, args, {
    cwd: path.dirname(sourcePath),
    env: process.env,
    timeoutMs: Number(process.env.IVUCX_CONVERTER_TIMEOUT_MS || 180000)
  });

  if (result.timedOut) {
    throw buildError('Coq CIC exporter timed out', result);
  }
  if (result.exitCode !== 0) {
    throw buildError('Coq CIC exporter failed', result);
  }

  let rawJson = String(result.stdout || '').trim();
  if (!rawJson) {
    rawJson = await fs.readFile(tempOutput, 'utf8');
  }

  let structured;
  try {
    structured = JSON.parse(rawJson);
  } catch (error) {
    throw buildError('Coq CIC exporter returned invalid JSON', {
      stdout: result.stdout,
      stderr: result.stderr
    });
  }

  const theoremName = structured.theoremName || structured.name || path.parse(sourcePath).name;

  await writeJson(outPath, normalizeCicExport(structured, {
    sourceLanguage: 'Coq',
    sourceEncoding: structured.metadata && structured.metadata.extraction
      ? structured.metadata.extraction
      : 'external-coq-cic-exporter',
    theoremName
  }));
}

async function runMetaRocqExporter(sourceText, sourcePath, outPath) {
  const declarations = detectCoqDeclarations(sourceText);
  const target = declarations[declarations.length - 1];

  if (!target) {
    throw buildError('Could not find a named Coq declaration for CIC export', {
      supported: ['Theorem', 'Lemma', 'Fact', 'Remark', 'Corollary', 'Proposition', 'Definition', 'Fixpoint', 'Let']
    });
  }

  const templatePath = path.join(__dirname, 'coq-cic-metarocq-template.v');
  const templateSource = await fs.readFile(templatePath, 'utf8');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ivucx-coq-cic-'));
  const exportPath = path.join(tempDir, path.basename(sourcePath));
  const redirectPath = path.join(tempDir, 'coq-cic-export.json');

  const exporterBlock = templateSource
    .replaceAll('__IVUCX_TARGET_QUALID__', toCoqStringLiteral(target.fullName))
    .replaceAll('__IVUCX_OUTPUT_PATH__', toCoqStringLiteral(redirectPath));

  const exportSource = [
    sourceText,
    '',
    exporterBlock,
    ''
  ].join('\n');

  try {
    await fs.writeFile(exportPath, exportSource, 'utf8');

    const coqCommand = String(process.env.IVUCX_COQ_CMD || process.env.COQ_CMD || 'coqc').trim();
    const result = await runProcess(coqCommand, [exportPath], {
      cwd: tempDir,
      env: process.env,
      timeoutMs: Number(process.env.IVUCX_CONVERTER_TIMEOUT_MS || 180000)
    });

    if (result.timedOut) {
      throw buildError('Built-in MetaRocq Coq CIC exporter timed out', result);
    }
    if (result.exitCode !== 0) {
      throw buildError('Built-in MetaRocq Coq CIC exporter failed', result);
    }

    const rawJson = (await readTextIfExists(redirectPath)).trim()
      || (await readTextIfExists(`${redirectPath}.out`)).trim()
      || String(result.stdout || '').trim();
    if (!rawJson) {
      throw buildError('Built-in MetaRocq Coq CIC exporter did not emit JSON', result);
    }

    let structured;
    try {
      structured = JSON.parse(rawJson);
    } catch (error) {
      throw buildError('Built-in MetaRocq Coq CIC exporter returned invalid JSON', {
        stdout: result.stdout,
        stderr: result.stderr,
        redirected: rawJson
      });
    }

    await writeJson(outPath, normalizeCicExport(structured, {
      sourceLanguage: 'Coq',
      sourceEncoding: 'metarocq-template',
      theoremName: structured.theoremName || target.fullName
    }));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const { flags, positional } = parseCliArgs(process.argv.slice(2));
  const sourcePath = positional[0];
  const outPath = flags.out;

  if (!sourcePath || !outPath) {
    throw buildError('Usage: convert-coq-cic.cjs --out <path> <source-file>');
  }

  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const externalCommand = String(process.env.IVUCX_COQ_CIC_EXPORT_CMD || process.env.COQ_CIC_EXPORT_CMD || '').trim();

  if (externalCommand) {
    await runExternalCoqExporter(sourcePath, outPath);
    return;
  }

  await runMetaRocqExporter(sourceText, sourcePath, outPath);
}

main().catch(async (error) => {
  const details = error && error.details ? error.details : null;
  await writeJson(resolveOutPath(process.argv, path.join(process.cwd(), 'result.out')), {
    error: error && error.message ? error.message : 'Coq CIC converter failed',
    details
  });
  process.exit(1);
});
