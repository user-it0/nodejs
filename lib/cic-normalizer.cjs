const CIC_FORMAT = 'cic-v1';
const CIC_SCHEMA_VERSION = 1;

const binderInfoAliases = new Map([
  ['default', 'default'],
  ['explicit', 'default'],
  ['implicit', 'implicit'],
  ['strictimplicit', 'strict-implicit'],
  ['strict-implicit', 'strict-implicit'],
  ['instimplicit', 'instance'],
  ['instanceimplicit', 'instance'],
  ['instance', 'instance'],
  ['auxdecl', 'auxiliary'],
  ['auxiliary', 'auxiliary']
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeString(value, fallbackValue = '') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return fallbackValue;
}

function normalizeInteger(value, fallbackValue = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function normalizeBinderInfo(value) {
  const normalized = normalizeString(value, 'default')
    .toLowerCase()
    .replace(/[^a-z-]/g, '');
  return binderInfoAliases.get(normalized) || 'default';
}

function normalizeBinderName(value) {
  if (isPlainObject(value)) {
    return normalizeString(value.name || value.binder_name || value.binderName, '_');
  }
  return normalizeString(value, '_');
}

function normalizeBinderDescriptor(value) {
  if (!isPlainObject(value)) {
    return {
      name: normalizeBinderName(value),
      relevance: null
    };
  }

  return {
    name: normalizeBinderName(value),
    relevance: normalizeString(value.relevance, '')
  };
}

function normalizeLevel(level) {
  if (level === null || level === undefined) {
    return null;
  }

  if (typeof level === 'string') {
    return {
      kind: 'param',
      name: normalizeString(level, '_')
    };
  }

  if (!isPlainObject(level)) {
    return {
      kind: 'raw-level',
      value: level
    };
  }

  if (level.kind === 'succ') {
    return {
      kind: 'succ',
      of: normalizeLevel(level.of)
    };
  }

  if (level.kind === 'max' || level.kind === 'imax') {
    return {
      kind: level.kind,
      values: Array.isArray(level.values) ? level.values.map(normalizeLevel) : []
    };
  }

  if (level.kind === 'param') {
    return {
      kind: 'param',
      name: normalizeString(level.name || level.value, '_')
    };
  }

  if (hasOwn(level, 'succ')) {
    return {
      kind: 'succ',
      of: normalizeLevel(level.succ)
    };
  }

  if (Array.isArray(level.max)) {
    return {
      kind: 'max',
      values: level.max.map(normalizeLevel)
    };
  }

  if (Array.isArray(level.imax)) {
    return {
      kind: 'imax',
      values: level.imax.map(normalizeLevel)
    };
  }

  if (hasOwn(level, 'param') || hasOwn(level, 'name')) {
    return {
      kind: 'param',
      name: normalizeString(level.param || level.name, '_')
    };
  }

  return {
    kind: 'raw-level',
    value: level
  };
}

function readNodePayload(node, candidates) {
  for (const key of candidates) {
    if (hasOwn(node, key)) {
      return node[key];
    }
  }
  return undefined;
}

function normalizeTerm(node) {
  if (node === null || node === undefined) {
    return null;
  }

  if (typeof node === 'number' && Number.isFinite(node)) {
    return {
      kind: 'lit',
      literal: Number.isInteger(node) ? 'nat' : 'number',
      value: node
    };
  }

  if (typeof node === 'string') {
    return {
      kind: 'raw-text',
      value: node
    };
  }

  if (!isPlainObject(node)) {
    return {
      kind: 'raw',
      value: node
    };
  }

  const kind = normalizeString(node.kind).toLowerCase();
  if (kind === 'rel') {
    return {
      kind: 'rel',
      index: normalizeInteger(node.index, 0)
    };
  }

  if (kind === 'var') {
    return {
      kind: 'var',
      name: normalizeString(node.name || node.id, '_')
    };
  }

  if (kind === 'sort') {
    return {
      kind: 'sort',
      level: normalizeLevel(node.level)
    };
  }

  if (kind === 'const') {
    return {
      kind: 'const',
      name: normalizeString(node.name, '_'),
      universes: Array.isArray(node.universes) ? node.universes.map(normalizeLevel) : []
    };
  }

  if (kind === 'ind') {
    return {
      kind: 'ind',
      name: normalizeString(node.name || node.inductive, '_'),
      universes: Array.isArray(node.universes) ? node.universes.map(normalizeLevel) : []
    };
  }

  if (kind === 'construct') {
    return {
      kind: 'construct',
      inductive: normalizeString(node.inductive || node.typeName || node.name, '_'),
      ctorIndex: normalizeInteger(node.ctorIndex || node.index || node.constructorIndex, 0),
      universes: Array.isArray(node.universes) ? node.universes.map(normalizeLevel) : []
    };
  }

  if (kind === 'app') {
    return {
      kind: 'app',
      fn: normalizeTerm(node.fn),
      args: Array.isArray(node.args) ? node.args.map(normalizeTerm) : []
    };
  }

  if (kind === 'lambda' || kind === 'prod') {
    return {
      kind,
      name: normalizeString(node.name, '_'),
      binderInfo: normalizeBinderInfo(node.binderInfo),
      type: normalizeTerm(node.type),
      body: normalizeTerm(node.body)
    };
  }

  if (kind === 'let') {
    return {
      kind: 'let',
      name: normalizeString(node.name, '_'),
      type: normalizeTerm(node.type),
      value: normalizeTerm(node.value),
      body: normalizeTerm(node.body),
      nondep: Boolean(node.nondep)
    };
  }

  if (kind === 'cast') {
    return {
      kind: 'cast',
      castKind: normalizeString(node.castKind || node.mode, 'default'),
      term: normalizeTerm(node.term || node.value),
      type: normalizeTerm(node.type)
    };
  }

  if (kind === 'proj') {
    return {
      kind: 'proj',
      typeName: normalizeString(node.typeName || node.inductive, '_'),
      index: normalizeInteger(node.index, 0),
      struct: normalizeTerm(node.struct)
    };
  }

  if (kind === 'case') {
    return {
      kind: 'case',
      inductive: normalizeString(node.inductive || node.typeName, ''),
      predicate: isPlainObject(node.predicate)
        ? {
            universes: Array.isArray(node.predicate.universes) ? node.predicate.universes.map(normalizeLevel) : [],
            params: Array.isArray(node.predicate.params) ? node.predicate.params.map(normalizeTerm) : [],
            context: Array.isArray(node.predicate.context) ? node.predicate.context.map(normalizeBinderDescriptor) : [],
            returnType: normalizeTerm(node.predicate.returnType || node.predicate.return_type || node.predicate.preturn),
            raw: node.predicate.raw || null
          }
        : normalizeTerm(node.predicate),
      caseInfo: isPlainObject(node.caseInfo)
        ? {
            npars: normalizeInteger(node.caseInfo.npars, 0),
            relevance: normalizeString(node.caseInfo.relevance, '')
          }
        : null,
      discriminant: normalizeTerm(node.discriminant || node.scrutinee),
      branches: Array.isArray(node.branches)
        ? node.branches.map((branch) => ({
            names: Array.isArray(branch.names) ? branch.names.map(normalizeBinderDescriptor) : [],
            body: normalizeTerm(branch.body || branch.term || branch.expr)
          }))
        : []
    };
  }

  if (kind === 'fix' || kind === 'cofix') {
    return {
      kind,
      index: normalizeInteger(node.index, 0),
      definitions: Array.isArray(node.definitions)
        ? node.definitions.map((definition) => ({
            name: normalizeString(definition.name, '_'),
            type: normalizeTerm(definition.type),
            body: normalizeTerm(definition.body),
            recursiveArg: normalizeInteger(definition.recursiveArg, 0)
          }))
        : []
    };
  }

  if (kind === 'evar') {
    return {
      kind: 'evar',
      index: normalizeInteger(node.index || node.id, 0),
      args: Array.isArray(node.args) ? node.args.map(normalizeTerm) : []
    };
  }

  if (kind === 'lit') {
    return {
      kind: 'lit',
      literal: normalizeString(node.literal, 'raw'),
      value: hasOwn(node, 'value') ? node.value : null
    };
  }

  if (kind === 'array') {
    return {
      kind: 'array',
      universe: normalizeLevel(node.universe),
      elements: Array.isArray(node.elements) ? node.elements.map(normalizeTerm) : [],
      default: normalizeTerm(node.default),
      type: normalizeTerm(node.type)
    };
  }

  if (kind === 'raw' || kind === 'raw-level' || kind === 'raw-text') {
    return {
      kind,
      value: hasOwn(node, 'value') ? node.value : null
    };
  }

  if (hasOwn(node, 'bvar') || hasOwn(node, 'tRel')) {
    return {
      kind: 'rel',
      index: normalizeInteger(hasOwn(node, 'bvar') ? node.bvar : node.tRel, 0)
    };
  }

  if (hasOwn(node, 'tVar')) {
    return {
      kind: 'var',
      name: normalizeString(node.tVar, '_')
    };
  }

  if (hasOwn(node, 'sort') || hasOwn(node, 'tSort')) {
    return {
      kind: 'sort',
      level: normalizeLevel(hasOwn(node, 'sort') ? node.sort : node.tSort)
    };
  }

  if (hasOwn(node, 'const') || hasOwn(node, 'tConst')) {
    const payload = readNodePayload(node, ['const', 'tConst']);
    if (Array.isArray(payload)) {
      return {
        kind: 'const',
        name: normalizeString(payload[0], '_'),
        universes: Array.isArray(payload[1]) ? payload[1].map(normalizeLevel) : []
      };
    }
    return {
      kind: 'const',
      name: normalizeString(payload && (payload.name || payload.constant || payload[0]), '_'),
      universes: Array.isArray(payload && (payload.universes || payload.us || payload.levels))
        ? (payload.universes || payload.us || payload.levels).map(normalizeLevel)
        : []
    };
  }

  if (hasOwn(node, 'ind') || hasOwn(node, 'tInd')) {
    const payload = readNodePayload(node, ['ind', 'tInd']);
    if (Array.isArray(payload)) {
      return {
        kind: 'ind',
        name: normalizeString(payload[0], '_'),
        universes: Array.isArray(payload[1]) ? payload[1].map(normalizeLevel) : []
      };
    }
    return {
      kind: 'ind',
      name: normalizeString(payload && (payload.name || payload.inductive || payload.mind || payload.mutind), '_'),
      universes: Array.isArray(payload && (payload.universes || payload.us || payload.levels))
        ? (payload.universes || payload.us || payload.levels).map(normalizeLevel)
        : []
    };
  }

  if (hasOwn(node, 'construct') || hasOwn(node, 'tConstruct')) {
    const payload = readNodePayload(node, ['construct', 'tConstruct']);
    if (Array.isArray(payload)) {
      const inductivePayload = payload[0];
      return {
        kind: 'construct',
        inductive: normalizeString(
          isPlainObject(inductivePayload)
            ? (inductivePayload.name || inductivePayload.inductive || inductivePayload.mind || inductivePayload.mutind)
            : inductivePayload,
          '_'
        ),
        ctorIndex: normalizeInteger(payload[1], 0),
        universes: Array.isArray(payload[2]) ? payload[2].map(normalizeLevel) : []
      };
    }
    return {
      kind: 'construct',
      inductive: normalizeString(payload && (payload.inductive || payload.name || payload.typeName), '_'),
      ctorIndex: normalizeInteger(payload && (payload.ctorIndex || payload.index || payload.constructorIndex), 0),
      universes: Array.isArray(payload && (payload.universes || payload.us || payload.levels))
        ? (payload.universes || payload.us || payload.levels).map(normalizeLevel)
        : []
    };
  }

  if (hasOwn(node, 'app') || hasOwn(node, 'tApp')) {
    const payload = readNodePayload(node, ['app', 'tApp']);
    if (Array.isArray(payload)) {
      return {
        kind: 'app',
        fn: normalizeTerm(payload[0]),
        args: Array.isArray(payload[1]) ? payload[1].map(normalizeTerm) : payload.slice(1).map(normalizeTerm)
      };
    }
    return {
      kind: 'app',
      fn: normalizeTerm(payload && (payload.fn || payload.func || payload.head)),
      args: Array.isArray(payload && (payload.args || payload.spine))
        ? (payload.args || payload.spine).map(normalizeTerm)
        : []
    };
  }

  if (hasOwn(node, 'lam') || hasOwn(node, 'tLambda')) {
    const payload = readNodePayload(node, ['lam', 'tLambda']);
    if (Array.isArray(payload)) {
      return {
        kind: 'lambda',
        name: normalizeString(payload[0], '_'),
        binderInfo: 'default',
        type: normalizeTerm(payload[1]),
        body: normalizeTerm(payload[2])
      };
    }
    return {
      kind: 'lambda',
      name: normalizeString(payload && (payload.name || payload.binder || payload.na), '_'),
      binderInfo: normalizeBinderInfo(payload && (payload.binderInfo || payload.relevance)),
      type: normalizeTerm(payload && (payload.type || payload.ty)),
      body: normalizeTerm(payload && (payload.body || payload.value))
    };
  }

  if (hasOwn(node, 'forallE') || hasOwn(node, 'tProd')) {
    const payload = readNodePayload(node, ['forallE', 'tProd']);
    if (Array.isArray(payload)) {
      return {
        kind: 'prod',
        name: normalizeString(payload[0], '_'),
        binderInfo: 'default',
        type: normalizeTerm(payload[1]),
        body: normalizeTerm(payload[2])
      };
    }
    return {
      kind: 'prod',
      name: normalizeString(payload && (payload.name || payload.binder || payload.na), '_'),
      binderInfo: normalizeBinderInfo(payload && (payload.binderInfo || payload.relevance)),
      type: normalizeTerm(payload && (payload.type || payload.ty)),
      body: normalizeTerm(payload && (payload.body || payload.value))
    };
  }

  if (hasOwn(node, 'letE') || hasOwn(node, 'tLetIn')) {
    const payload = readNodePayload(node, ['letE', 'tLetIn']);
    if (Array.isArray(payload)) {
      return {
        kind: 'let',
        name: normalizeString(payload[0], '_'),
        type: normalizeTerm(payload[1]),
        value: normalizeTerm(payload[2]),
        body: normalizeTerm(payload[3]),
        nondep: false
      };
    }
    return {
      kind: 'let',
      name: normalizeString(payload && (payload.name || payload.binder || payload.na), '_'),
      type: normalizeTerm(payload && (payload.type || payload.ty)),
      value: normalizeTerm(payload && (payload.value || payload.term)),
      body: normalizeTerm(payload && payload.body),
      nondep: Boolean(payload && payload.nondep)
    };
  }

  if (hasOwn(node, 'proj') || hasOwn(node, 'tProj')) {
    const payload = readNodePayload(node, ['proj', 'tProj']);
    if (Array.isArray(payload)) {
      return {
        kind: 'proj',
        typeName: normalizeString(payload[0], '_'),
        index: normalizeInteger(payload[1], 0),
        struct: normalizeTerm(payload[2])
      };
    }
    return {
      kind: 'proj',
      typeName: normalizeString(payload && (payload.typeName || payload.inductive || payload.projection), '_'),
      index: normalizeInteger(payload && (payload.index || payload.idx || payload.narg), 0),
      struct: normalizeTerm(payload && (payload.struct || payload.term || payload.value))
    };
  }

  if (hasOwn(node, 'tCast')) {
    const payload = node.tCast;
    if (Array.isArray(payload)) {
      return {
        kind: 'cast',
        castKind: normalizeString(payload[1], 'default'),
        term: normalizeTerm(payload[0]),
        type: normalizeTerm(payload[2])
      };
    }
    return {
      kind: 'cast',
      castKind: normalizeString(payload && (payload.kind || payload.castKind), 'default'),
      term: normalizeTerm(payload && (payload.term || payload.value)),
      type: normalizeTerm(payload && payload.type)
    };
  }

  if (hasOwn(node, 'tCase')) {
    const payload = node.tCase;
    return {
      kind: 'case',
      inductive: normalizeString(payload && (payload.inductive || payload.typeName || payload.ci), ''),
      predicate: normalizeTerm(payload && (payload.predicate || payload.returnType)),
      discriminant: normalizeTerm(payload && (payload.discriminant || payload.scrutinee)),
      branches: Array.isArray(payload && payload.branches)
        ? payload.branches.map((branch) => ({
            names: Array.isArray(branch.names) ? branch.names.map((name) => normalizeString(name, '_')) : [],
            body: normalizeTerm(branch.body || branch.term)
          }))
        : []
    };
  }

  if (hasOwn(node, 'tFix') || hasOwn(node, 'tCoFix')) {
    const payload = readNodePayload(node, ['tFix', 'tCoFix']);
    const isCofix = hasOwn(node, 'tCoFix');
    const definitions = Array.isArray(payload && payload.definitions)
      ? payload.definitions
      : Array.isArray(payload && payload[0]) ? payload[0] : [];
    const index = Array.isArray(payload) ? payload[1] : payload && payload.index;

    return {
      kind: isCofix ? 'cofix' : 'fix',
      index: normalizeInteger(index, 0),
      definitions: definitions.map((definition) => ({
        name: normalizeString(definition.name || definition.binder || definition.na, '_'),
        type: normalizeTerm(definition.type || definition.ty),
        body: normalizeTerm(definition.body || definition.term),
        recursiveArg: normalizeInteger(definition.recursiveArg || definition.rarg, 0)
      }))
    };
  }

  if (hasOwn(node, 'natVal') || hasOwn(node, 'strVal') || hasOwn(node, 'intVal')) {
    if (hasOwn(node, 'natVal')) {
      return {
        kind: 'lit',
        literal: 'nat',
        value: node.natVal
      };
    }
    if (hasOwn(node, 'intVal')) {
      return {
        kind: 'lit',
        literal: 'int',
        value: node.intVal
      };
    }
    return {
      kind: 'lit',
      literal: 'string',
      value: node.strVal
    };
  }

  if (hasOwn(node, 'tEvar')) {
    const payload = node.tEvar;
    if (Array.isArray(payload)) {
      return {
        kind: 'evar',
        index: normalizeInteger(payload[0], 0),
        args: Array.isArray(payload[1]) ? payload[1].map(normalizeTerm) : []
      };
    }
    return {
      kind: 'evar',
      index: normalizeInteger(payload && (payload.index || payload.id), 0),
      args: Array.isArray(payload && payload.args) ? payload.args.map(normalizeTerm) : []
    };
  }

  return {
    kind: 'raw',
    value: node
  };
}

function normalizeContext(context) {
  if (!isPlainObject(context)) {
    return context ? { raw: context } : null;
  }

  const assumptions = Array.isArray(context.assumptions)
    ? context.assumptions.map((entry) => ({
        name: normalizeString(entry && entry.name, '_'),
        type: normalizeTerm(entry && entry.type),
        value: normalizeTerm(entry && entry.value)
      }))
    : null;

  return {
    type: normalizeTerm(context.type || context.typ || context.proposition || null),
    assumptions
  };
}

function normalizeDeclaration(declaration) {
  if (!isPlainObject(declaration)) {
    return {
      kind: 'raw',
      value: declaration
    };
  }

  return {
    kind: normalizeString(declaration.kind || declaration.declKind, 'declaration'),
    name: normalizeString(declaration.name || declaration.theoremName, ''),
    type: normalizeTerm(declaration.type),
    term: normalizeTerm(declaration.term || declaration.value || declaration.body),
    metadata: isPlainObject(declaration.metadata) ? declaration.metadata : null
  };
}

function normalizeDeclarations(declarations) {
  if (!Array.isArray(declarations)) {
    return null;
  }
  return declarations.map(normalizeDeclaration);
}

function collectTermStats(term, stats) {
  if (!term) {
    return;
  }

  if (Array.isArray(term)) {
    for (const entry of term) {
      collectTermStats(entry, stats);
    }
    return;
  }

  if (!isPlainObject(term)) {
    return;
  }

  if (term.kind === 'raw') {
    stats.rawTerms += 1;
  } else if (term.kind === 'raw-level') {
    stats.rawLevels += 1;
  } else if (term.kind === 'raw-text') {
    stats.rawTexts += 1;
  }

  for (const value of Object.values(term)) {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectTermStats(entry, stats));
    } else if (isPlainObject(value)) {
      collectTermStats(value, stats);
    }
  }
}

function normalizeCicExport(payload, options = {}) {
  const theoremName = normalizeString(
    (payload && (payload.theoremName || payload.name))
      || options.theoremName
      || options.fallbackTheoremName,
    'Main'
  );

  const term = normalizeTerm(payload && (payload.term || payload.expression || payload.ast || payload.pcuic || payload.cic || payload.value));
  const context = normalizeContext(payload && (payload.context || (payload && payload.type ? { type: payload.type } : null)));
  const declarations = normalizeDeclarations(payload && payload.declarations);
  const stats = {
    rawTerms: 0,
    rawLevels: 0,
    rawTexts: 0
  };

  collectTermStats(term, stats);
  collectTermStats(context, stats);
  collectTermStats(declarations, stats);

  const upstreamMetadata = isPlainObject(payload && payload.metadata) ? payload.metadata : {};
  const normalization = {
    targetFormat: CIC_FORMAT,
    schemaVersion: CIC_SCHEMA_VERSION,
    sourceEncoding: options.sourceEncoding || normalizeString(upstreamMetadata.extraction, 'unknown'),
    rawTermNodes: stats.rawTerms,
    rawLevelNodes: stats.rawLevels,
    rawTextNodes: stats.rawTexts
  };

  return {
    format: CIC_FORMAT,
    schemaVersion: CIC_SCHEMA_VERSION,
    theoremName,
    term,
    context,
    declarations,
    metadata: {
      ...upstreamMetadata,
      sourceLanguage: options.sourceLanguage || upstreamMetadata.sourceLanguage || 'unknown',
      normalization
    }
  };
}

module.exports = {
  CIC_FORMAT,
  CIC_SCHEMA_VERSION,
  normalizeBinderInfo,
  normalizeContext,
  normalizeCicExport,
  normalizeDeclaration,
  normalizeDeclarations,
  normalizeLevel,
  normalizeTerm
};
