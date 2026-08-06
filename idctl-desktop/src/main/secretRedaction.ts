const SAFE_TOKEN_COUNTER_KEYS = new Set([
  'context_tokens',
  'max_tokens',
  'original_tokens',
  'saved_tokens',
  'sent_tokens',
  'token_count',
  'tokens',
]);

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
}

function secretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SAFE_TOKEN_COUNTER_KEYS.has(normalized)) return false;
  if (/(?:^|_)(?:api_key|access_token|auth_token|bearer|credential|secret|password|passphrase|private_key|seed|mnemonic|authorization|cookie|signature|signed_payload)(?:_|$)/.test(normalized)) {
    return true;
  }
  return /(?:^|_)token(?:_|$)/.test(normalized);
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/gi, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\s*[:=]\s*[^\s,;]{8,}/gi, '$1=[REDACTED]')
    .replace(/(--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret)(?:=|\s+))[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|key|secret|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/:\/\/[^/@\s:]+:[^/@\s]+@/g, '://[REDACTED]@');
}

/**
 * Prepare an IPC/log payload for the renderer or Brain audit stream. Secret
 * fields are replaced recursively and common credential shapes are redacted
 * from free-form text.
 */
export function sanitizeSecretPayload<T>(value: T): T {
  const seen = new WeakSet<object>();
  const walk = (input: unknown): unknown => {
    if (typeof input === 'string') return redactString(input);
    if (input == null || typeof input !== 'object') return input;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) return '[BINARY REDACTED]';
    if (seen.has(input)) return '[CIRCULAR]';
    seen.add(input);
    if (Array.isArray(input)) return input.map(walk);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
      output[key] = secretKey(key)
        ? (child == null || child === '' ? child : '[REDACTED]')
        : walk(child);
    }
    return output;
  };
  return walk(value) as T;
}
