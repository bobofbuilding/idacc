import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { relative, sep } from 'node:path';

const TEXT_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.plist',
  '.sh',
  '.toml',
  '.txt',
  '.yaml',
  '.yml',
]);
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

const FORBIDDEN_PATHS = [
  {
    label: 'organization-specific Manager configuration',
    re: /^manager\/configs\/(?:bittrees|skillmesh)(?:[-_.][^/]*)?\.(?:ya?ml|json)$/i,
  },
  {
    label: 'organization-specific Manager skill or plugin',
    re: /^manager\/(?:skills|plugins)\/[^/]*(?:bittrees|skillmesh)[^/]*(?:\/|$)/i,
  },
  {
    label: 'Brain seed data',
    re: /^brain\/seeds(?:\/|$)/i,
  },
  {
    label: 'Brain operator tooling',
    re: /^brain\/operator-tools\/(?!refresh-source-embeddings\.mjs$).+/i,
  },
  {
    label: 'organization-specific Brain executable',
    re: /^brain\/(?:bittrees[^/]*|ingest-bittrees|skill-loop-[^/]*|sync-onchain|demand-proof|quota-watch|projects-sync)\.(?:c?m?js|sh)$/i,
  },
  {
    label: 'operator-owned Brain material',
    re: /^brain\/(?:control-center|launchd|output|plans|test|docs|electron)(?:\/|$)/i,
  },
  {
    label: 'secret-bearing file type',
    re: /(?:^|\/)(?:id_rsa|id_ed25519|[^/]*\.(?:key|pem|p8|p12|mnemonic|seed))(?:$|\/)/i,
  },
  {
    label: 'environment or credential file',
    re: /(?:^|\/)\.env(?:[._-][^/]*)?$/i,
  },
  {
    label: 'developer admin helper executable',
    re: /^manager\/skills\/idagents-admin-control\/(?!SKILL\.md$)[^/]+$/i,
  },
  {
    label: 'non-core privileged consumer skill',
    re: /^manager\/skills\/(?:idagents-team-builder|wallet)(?:\/|$)/i,
  },
];

const PERSONAL_PATH_PATTERNS = [
  /(?<![A-Za-z0-9_])\/Users\/(?!Shared(?:\/|$))[^/\s"'`<>]+(?:\/[^\s"'`<>]*)?/g,
  /(?<![A-Za-z0-9_])\/home\/(?!runner(?:\/|$))[^/\s"'`<>]+(?:\/[^\s"'`<>]*)?/g,
  /[A-Za-z]:\\Users\\[^\\\s"'`<>]+(?:\\[^\s"'`<>]*)?/gi,
  /["'`]bob["'`]\s*,\s*["'`]Library["'`]\s*,\s*["'`]Assistants["'`]\s*,\s*["'`]idagents["'`]/gi,
];

const SECRET_CONTENT_PATTERNS = [
  {
    label: 'embedded private key block',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  },
  {
    label: 'embedded secret assignment',
    re: /\b(?:PRIVATE_KEY|SECRET_KEY|MNEMONIC|SEED_PHRASE|RECOVERY_PHRASE)\b\s*[:=]\s*["'`](?!\s*(?:process\.env|\$\{|<|example|redacted|replace-me))[^"'`\r\n]{12,}["'`]/i,
  },
  {
    label: 'embedded raw private key',
    re: /\b(?:PRIVATE_KEY|SECRET_KEY)\b[^\r\n]{0,48}\b0x[0-9a-f]{64}\b/i,
  },
];

const ACTIVE_ORG_POLICY_PATTERNS = [
  {
    label: 'hard-coded organization service URL',
    re: /https?:\/\/[^\s"'`<>]*\b(?:bittrees|skillmesh)\b[^\s"'`<>]*/i,
  },
  {
    label: 'organization-specific default team policy',
    re: /\b(?:default(?:Team|_team)?|team|owner_route|assignee)\s*[:=]\s*["'`](?:bittrees|skillmesh)(?:[-_][^"'`]*)?["'`]/i,
  },
];

const EMBEDDED_PROFILE_STATE_PATTERNS = [
  {
    label: 'embedded profile-owned goal dataset',
    re: /["']goals["']\s*:\s*\[\s*\{(?=[\s\S]{0,4096}["']id["']\s*:\s*["']goal_[^"']+["'])(?=[\s\S]{0,4096}["'](?:objective|title)["']\s*:\s*["'][^"'\r\n]{3,}["'])[\s\S]{0,4096}\}/i,
  },
  {
    label: 'embedded profile-owned plan dataset',
    re: /["']plans["']\s*:\s*\[\s*\{(?=[\s\S]{0,4096}["']id["']\s*:\s*["']plan_[^"']+["'])(?=[\s\S]{0,4096}["'](?:objective|title|content)["']\s*:\s*["'][^"'\r\n]{3,}["'])[\s\S]{0,4096}\}/i,
  },
  {
    label: 'embedded profile-owned dream dataset',
    re: /["']dreams["']\s*:\s*\[\s*\{(?=[\s\S]{0,4096}["']id["']\s*:\s*["']dream_[^"']+["'])(?=[\s\S]{0,4096}["'](?:objective|title|prompt)["']\s*:\s*["'][^"'\r\n]{3,}["'])[\s\S]{0,4096}\}/i,
  },
  {
    label: 'embedded profile-owned question dataset',
    re: /["']questions["']\s*:\s*\[\s*\{(?=[\s\S]{0,4096}["']id["']\s*:\s*["']q_[^"']+["'])(?=[\s\S]{0,4096}["'](?:question|prompt|answer)["']\s*:\s*["'][^"'\r\n]{3,}["'])[\s\S]{0,4096}\}/i,
  },
];

const CONSUMER_CORE_SKILL_PATTERNS = [
  {
    label: 'fixed development service address',
    paths: /^manager\/skills\/[^/]+\/SKILL\.md$/i,
    re: /https?:\/\/(?:localhost|127\.0\.0\.1):(?:4050|4100|4200)\b/i,
  },
  {
    label: 'raw Brain HTTP instruction',
    paths: /^manager\/skills\/brain\/SKILL\.md$/i,
    re: /\bcurl\b/i,
  },
  {
    label: 'development checkout assumption',
    paths: /^manager\/skills\/[^/]+\/SKILL\.md$/i,
    re: /(?:\$HOME|~)\/(?:id-agents|idacc)\b|(?:^|[\s"'`])cd\s+[^\r\n]*(?:id-agents|idacc)(?:[\s"'`]|$)/im,
  },
  {
    label: 'unsafe process-control instruction',
    paths: /^manager\/skills\/[^/]+\/SKILL\.md$/i,
    re: /\b(?:kill\s+-9|pkill|killall)\b|\bxargs\b[^\r\n]*\bkill\b|\bnohup\b[^\r\n]*start-agent-manager/i,
  },
  {
    label: 'organization-specific skill example',
    paths: /^manager\/skills\/[^/]+\/SKILL\.md$/i,
    re: /\b(?:idchain|xid\.eth)\b/i,
  },
  {
    label: 'raw Manager command call',
    paths: /^manager\/skills\/[^/]+\/SKILL\.md$/i,
    re: /\bcurl\b[^\r\n]{0,240}\/remote\b|(?:POST|GET|PATCH|DELETE)\s+[^\r\n]{0,160}\/remote\b/i,
  },
  {
    label: 'external wallet vault assumption',
    paths: /^manager\/skills\/[^/]+\/SKILL\.md$/i,
    re: /(?:~|\$HOME)\/\.ows\b/i,
  },
  {
    label: 'unsafe permission bypass instruction',
    paths: /^manager\/skills\/[^/]+\/SKILL\.md$/i,
    re: /\bdangerouslySkipPermissions\b/i,
  },
  {
    label: 'pinned provider model example',
    paths: /^manager\/skills\/[^/]+\/SKILL\.md$/i,
    re: /\b(?:claude-(?:opus|sonnet|haiku)|gpt-\d)[a-z0-9._-]*\b/i,
  },
  {
    label: 'provider or privileged feature pinned in default team',
    paths: /^manager\/configs\/default\.ya?ml$/i,
    re: /^\s*(?:runtime|model|wallet)\s*:\s*(?:true|[^\s#]+)|^\s*-\s*(?:wallet|xmtp|idagents-admin-control|idagents-team-builder)\s*$/im,
  },
];

function portablePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

export function portableArchiveEntry(value) {
  return String(value ?? '').replace(/^[\\/]+/, '').split(/[\\/]+/).join('/');
}

function extension(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const index = name.lastIndexOf('.');
  return index <= 0 ? '' : name.slice(index).toLowerCase();
}

function isFirstParty(path) {
  return !path.split('/').includes('node_modules');
}

function isConsumerAsset(path) {
  // The generated runtime manifest is a neutral inventory. It can legitimately
  // name dormant, optional provider modules while the files themselves remain
  // subject to every path, secret, endpoint, and active-default check.
  if (/(?:^|\/)manifest\.json$/i.test(path)) return false;
  return (
    /^manager\/(?:configs|skills|plugins)\//i.test(path)
    || /^brain\/(?:prompts|seeds|operator-tools)\//i.test(path)
    || (!/\.(?:c?m?js)$/i.test(path) && !/(?:^|\/)package-lock\.json$/i.test(path))
  );
}

function contentPreview(match) {
  return String(match || '').replace(/\s+/g, ' ').slice(0, 120);
}

export function inspectConsumerTextEntry(relativePath, content, options = {}) {
  const { runtimePolicy = false } = options;
  const errors = [];
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  if (buffer.byteLength > MAX_TEXT_BYTES || !TEXT_EXTENSIONS.has(extension(relativePath))) return errors;
  if (buffer.includes(0)) return errors;
  const text = buffer.toString('utf8');

  for (const pattern of PERSONAL_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) {
      errors.push(`personal absolute path in ${relativePath}: ${contentPreview(match[0])}`);
    }
  }
  for (const { label, re } of SECRET_CONTENT_PATTERNS) {
    const match = text.match(re);
    if (match) errors.push(`${label} in ${relativePath}`);
  }
  for (const { label, re } of ACTIVE_ORG_POLICY_PATTERNS) {
    const match = text.match(re);
    if (match) errors.push(`${label} in ${relativePath}: ${contentPreview(match[0])}`);
  }
  for (const { label, re } of EMBEDDED_PROFILE_STATE_PATTERNS) {
    const match = text.match(re);
    if (match) errors.push(`${label} in ${relativePath}`);
  }
  if (runtimePolicy && isConsumerAsset(relativePath)) {
    const match = text.match(/\b(?:bittrees|skillmesh)\b/i);
    if (match) {
      errors.push(`organization-specific consumer asset content in ${relativePath}: ${match[0]}`);
    }
  }
  if (runtimePolicy) {
    for (const { label, paths, re } of CONSUMER_CORE_SKILL_PATTERNS) {
      if (!paths.test(relativePath)) continue;
      const match = text.match(re);
      if (match) errors.push(`${label} in ${relativePath}: ${contentPreview(match[0])}`);
    }
  }
  return errors;
}

function inspectText(path, relativePath, errors) {
  const stat = lstatSync(path);
  if (stat.size > MAX_TEXT_BYTES || !TEXT_EXTENSIONS.has(extension(relativePath))) return;
  errors.push(...inspectConsumerTextEntry(relativePath, readFileSync(path), { runtimePolicy: true }));
}

function walk(root, current, errors) {
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = `${current}${sep}${entry.name}`;
    const relativePath = portablePath(root, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      walk(root, path, errors);
      continue;
    }
    if (!stat.isFile() || !isFirstParty(relativePath)) continue;
    for (const { label, re } of FORBIDDEN_PATHS) {
      if (re.test(relativePath)) errors.push(`${label}: ${relativePath}`);
    }
    inspectText(path, relativePath, errors);
  }
}

export function inspectConsumerPayload(root) {
  if (!existsSync(root) || !lstatSync(root).isDirectory()) {
    return [`consumer runtime is not a directory: ${root}`];
  }
  const errors = [];
  walk(root, root, errors);
  return [...new Set(errors)].sort();
}

export function assertConsumerPayload(root, label = 'consumer runtime') {
  const errors = inspectConsumerPayload(root);
  if (errors.length) {
    throw new Error(`${label} violates the consumer-neutral payload policy:\n- ${errors.join('\n- ')}`);
  }
}
