import assert from 'node:assert/strict';
import { sanitizeSecretPayload } from '../src/main/secretRedaction.ts';

const secret = 'sk-' + 'x'.repeat(32);
const sanitized = sanitizeSecretPayload({
  provider: {
    apiKey: secret,
    apiKeyEncrypted: 'ciphertext',
    baseUrl: 'https://example.test',
  },
  mcp: {
    env: { OPENAI_API_KEY: secret, PATH: '/usr/bin' },
    headers: { Authorization: `Bearer ${'a'.repeat(32)}` },
  },
  note: `credential api_key=${secret}`,
  cli: `tool --token ${'b'.repeat(32)} --safe value`,
  endpoint: `https://user:${'c'.repeat(24)}@example.test/mcp?token=${'d'.repeat(24)}&view=tools`,
  savedTokens: 42,
  tokenCount: 2,
  projectId: 'public-project-id',
});

const text = JSON.stringify(sanitized);
assert.doesNotMatch(text, new RegExp(secret));
assert.doesNotMatch(text, new RegExp('a'.repeat(32)));
assert.doesNotMatch(text, new RegExp('b'.repeat(32)));
assert.doesNotMatch(text, new RegExp('c'.repeat(24)));
assert.doesNotMatch(text, new RegExp('d'.repeat(24)));
assert.equal(sanitized.provider.apiKey, '[REDACTED]');
assert.equal(sanitized.provider.apiKeyEncrypted, '[REDACTED]');
assert.equal(sanitized.mcp.env.PATH, '/usr/bin');
assert.equal(sanitized.savedTokens, 42);
assert.equal(sanitized.tokenCount, 2);
assert.equal(sanitized.projectId, 'public-project-id');
process.stdout.write('secret redaction smoke: ok\n');
