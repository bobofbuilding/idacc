#!/usr/bin/env node
/**
 * Zero-dependency validator for brain-connector.json against
 * brain-connector.schema.json.
 *
 * The brain project ships no JSON-Schema dependency, so this implements the
 * exact draft 2020-12 subset the connector schema uses:
 *   type (incl. union arrays + "integer"), enum, const, required, properties,
 *   additionalProperties:false, items, minItems, minLength, minimum, maximum,
 *   allOf, anyOf, if/then/else, and local $ref into #/$defs.
 *
 * Usage:
 *   node brain-connector-validate.mjs <brain-connector.json> [more.json ...]
 *   node brain-connector-validate.mjs --registry [~/.brain-connectors.json]
 *
 * Exit 0 if every input is valid, 1 otherwise.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, 'brain-connector.schema.json');

export function loadSchema(path = SCHEMA_PATH) {
  return JSON.parse(readFileSync(isAbsolute(path) ? path : resolve(path), 'utf8'));
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'object' | 'string' | 'number' | 'boolean'
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  const actual = jsonType(value);
  return types.some((t) => {
    if (t === 'integer') return actual === 'number' && Number.isInteger(value);
    if (t === 'number') return actual === 'number';
    return t === actual;
  });
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (jsonType(a) !== jsonType(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (a && typeof a === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref: ${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => {
    if (!node || !(key in node)) throw new Error(`cannot resolve $ref: ${ref}`);
    return node[key];
  }, root);
}

function validateNode(schema, value, path, root, errors) {
  // Boolean schemas: `true` accepts anything, `false` rejects everything.
  if (schema === true) return;
  if (schema === false) { errors.push(`${path || '(root)'}: schema is false (nothing is valid here)`); return; }

  if (schema.$ref) {
    validateNode(resolveRef(schema.$ref, root), value, path, root, errors);
    return;
  }

  const at = path || '(root)';

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${at}: expected type ${JSON.stringify(schema.type)}, got ${jsonType(value)}`);
    return; // downstream checks are unreliable once the type is wrong
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((opt) => deepEqual(opt, value))) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: ${value} below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: ${value} above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: array has ${value.length} items, fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) value.forEach((item, i) => validateNode(schema.items, item, `${at}[${i}]`, root, errors));
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${at}: missing required property "${req}"`);
    }
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateNode(sub, value[key], path ? `${path}.${key}` : key, root, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${at}: unknown property "${key}"`);
      }
    }
  }

  for (const sub of schema.allOf ?? []) validateNode(sub, value, path, root, errors);

  if (schema.anyOf && !schema.anyOf.some((sub) => isValid(sub, value, root))) {
    errors.push(`${at}: satisfies none of anyOf (${anyOfHint(schema.anyOf)})`);
  }

  if (schema.if) {
    if (isValid(schema.if, value, root)) {
      if (schema.then) validateNode(schema.then, value, path, root, errors);
    } else if (schema.else) {
      validateNode(schema.else, value, path, root, errors);
    }
  }
}

function isValid(schema, value, root) {
  const errs = [];
  validateNode(schema, value, '', root, errs);
  return errs.length === 0;
}

function anyOfHint(anyOf) {
  const keys = [...new Set(anyOf.flatMap((s) => s.required ?? []))];
  return keys.length ? `needs one of: ${keys.join(', ')}` : 'see schema';
}

/** Validate an in-memory connector object. Returns { valid, errors }. */
export function validateConnector(connector, { schema = loadSchema() } = {}) {
  const errors = [];
  validateNode(schema, connector, '', schema, errors);
  return { valid: errors.length === 0, errors };
}

/** Validate a brain-connector.json file. Returns { valid, errors, connector }. */
export function validateConnectorFile(file, { schema = loadSchema() } = {}) {
  const resolved = isAbsolute(file) ? file : resolve(file);
  let connector;
  try {
    connector = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    return { valid: false, errors: [`${resolved}: not readable/parseable JSON — ${error.message}`], connector: null };
  }
  return { ...validateConnector(connector, { schema }), connector };
}

/** Validate every connector referenced by a ~/.brain-connectors.json registry. */
export function validateRegistry(registryFile = process.env.BRAIN_CONNECTORS_REGISTRY || join(homedir(), '.brain-connectors.json'), { schema = loadSchema() } = {}) {
  const resolved = isAbsolute(registryFile) ? registryFile : resolve(registryFile);
  if (!existsSync(resolved)) return { valid: true, registry: resolved, results: [], errors: [`registry not found: ${resolved} (nothing to validate)`] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    return { valid: false, registry: resolved, results: [], errors: [`${resolved}: not parseable JSON — ${error.message}`] };
  }
  if (!Array.isArray(parsed.connectors)) {
    return { valid: false, registry: resolved, results: [], errors: [`${resolved}: must contain a "connectors" array`] };
  }
  const registryDir = dirname(resolved);
  const results = parsed.connectors.map(String).filter(Boolean).map((entry) => {
    const connectorPath = isAbsolute(entry) ? entry : resolve(registryDir, entry);
    return { file: connectorPath, ...validateConnectorFile(connectorPath, { schema }) };
  });
  return { valid: results.every((r) => r.valid), registry: resolved, results, errors: [] };
}

function main(argv) {
  const schema = loadSchema();
  if (argv[0] === '--registry') {
    const report = validateRegistry(argv[1], { schema });
    for (const note of report.errors) console.error(note);
    for (const r of report.results) {
      if (r.valid) console.log(`ok    ${r.file}`);
      else { console.error(`FAIL  ${r.file}`); r.errors.forEach((e) => console.error(`        - ${e}`)); }
    }
    return report.valid ? 0 : 1;
  }
  if (argv.length === 0) {
    console.error('Usage: node brain-connector-validate.mjs <brain-connector.json> [more.json ...]');
    console.error('       node brain-connector-validate.mjs --registry [~/.brain-connectors.json]');
    return 2;
  }
  let ok = true;
  for (const file of argv) {
    const { valid, errors } = validateConnectorFile(file, { schema });
    if (valid) {
      console.log(`ok    ${file}`);
    } else {
      ok = false;
      console.error(`FAIL  ${file}`);
      errors.forEach((e) => console.error(`        - ${e}`));
    }
  }
  return ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
