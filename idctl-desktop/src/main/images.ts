/**
 * Image generation + caching (main process). Generates via the configured
 * OpenRouter-style provider (chat/completions with an image-output model, which
 * returns a base64 data URL), caches the PNG to <config>/chats/images/, and
 * reads cached images back as data URLs for CSP-safe (`img-src 'self' data:`)
 * display in the sandboxed renderer.
 */

import { writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { loadSettings, resolveProviderKey } from '../../../idctl/src/settings/store.ts';
import type { ImageServerConfig } from '../../../idctl/src/settings/schema.ts';
import { chatImagesDir } from './chatstore.ts';

const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const QUALITY_MODEL = 'google/gemini-3-pro-image';

/** Pick an image model from the prompt: a higher-quality model when the prompt
 *  asks for it, else the fast/cheap default. (Replaces the manual model picker.) */
function pickImageModel(prompt: string): string {
  return /\b(photo-?realistic|photoreal|high[- ]?(quality|res|resolution)|hi-?res|detailed|intricate|4k|8k|ultra|professional|logo|poster|render(ing)?|cinematic)\b/i.test(prompt)
    ? QUALITY_MODEL
    : DEFAULT_IMAGE_MODEL;
}

/** The CLOUD provider used for image generation: prefer OpenRouter, else any
 *  enabled openai-compatible/openai provider. */
function imageProvider() {
  const ps = (loadSettings().providers ?? []).filter((p) => p.enabled !== false);
  return ps.find((p) => p.name === 'openrouter') || ps.find((p) => p.kind === 'openai-compatible' || p.kind === 'openai');
}

export interface ImageResult { ok: boolean; path?: string; dataUrl?: string; model?: string; costUsd?: number; provider?: string; error?: string }

/** Persist a decoded image buffer to the cache; returns its path + a data URL. */
function cacheImage(buf: Buffer, mime: string): { path: string; dataUrl: string } {
  const ext = EXT_FOR[mime.toLowerCase()] || 'png';
  const name = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const path = join(chatImagesDir(), name);
  writeFileSync(path, buf, { mode: 0o600 });
  return { path, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

/** Generate via a local Automatic1111 / Stable Diffusion WebUI (`/sdapi/v1/txt2img`). */
async function genViaAuto1111(url: string, prompt: string): Promise<ImageResult> {
  const quality = /\b(detailed|intricate|4k|8k|ultra|hi-?res|high[- ]?res|photoreal|photo-?realistic|cinematic)\b/i.test(prompt);
  try {
    const r = await fetch(`${url}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, steps: quality ? 35 : 22, width: 1024, height: 1024, cfg_scale: 7 }),
      signal: AbortSignal.timeout(300000),
    });
    if (!r.ok) { let d = ''; try { d = (await r.text()).slice(0, 200); } catch { /* */ } return { ok: false, error: `local SD ${r.status}${d ? `: ${d}` : ''}` }; }
    const j = (await r.json()) as Record<string, any>;
    const b64 = (j?.images || [])[0]; // Automatic1111 returns raw base64 PNG (no data: prefix)
    if (!b64 || typeof b64 !== 'string') return { ok: false, error: 'local SD returned no image' };
    const buf = Buffer.from(b64.replace(/^data:image\/[a-z.+-]+;base64,/i, ''), 'base64');
    if (buf.length < 64) return { ok: false, error: 'local SD returned an empty image' };
    const { path, dataUrl } = cacheImage(buf, 'image/png');
    return { ok: true, path, dataUrl, model: 'stable-diffusion', provider: 'local SD' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Generate via an OpenAI-style images API (`/v1/images/generations`) — LocalAI,
 *  OpenAI, etc. Handles both b64_json and url responses. */
async function genViaOpenAIImages(url: string, model: string | undefined, prompt: string, key?: string): Promise<ImageResult> {
  const base = url.replace(/\/+$/, '');
  const endpoint = /\/v\d+$/.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: model || 'gpt-image-1', prompt, n: 1, size: '1024x1024', response_format: 'b64_json' }),
      signal: AbortSignal.timeout(300000),
    });
    if (!r.ok) { let d = ''; try { d = (await r.text()).slice(0, 200); } catch { /* */ } return { ok: false, error: `images API ${r.status}${d ? `: ${d}` : ''}` }; }
    const j = (await r.json()) as Record<string, any>;
    const d0 = (j?.data || [])[0];
    if (d0?.b64_json) {
      const buf = Buffer.from(String(d0.b64_json), 'base64');
      if (buf.length < 64) return { ok: false, error: 'images API returned an empty image' };
      const { path, dataUrl } = cacheImage(buf, 'image/png');
      return { ok: true, path, dataUrl, model: model || 'image', provider: 'local image API' };
    }
    if (d0?.url && /^https?:/.test(d0.url)) {
      const ir = await fetch(d0.url, { signal: AbortSignal.timeout(60000) });
      if (!ir.ok) return { ok: false, error: `image fetch ${ir.status}` };
      const buf = Buffer.from(await ir.arrayBuffer());
      const mime = ir.headers.get('content-type')?.split(';')[0] || 'image/png';
      if (!EXT_FOR[mime.toLowerCase()]) return { ok: false, error: `unsupported image format ${mime}` };
      const { path, dataUrl } = cacheImage(buf, mime);
      return { ok: true, path, dataUrl, model: model || 'image', provider: 'local image API' };
    }
    return { ok: false, error: 'images API returned no image' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Generate via a chat/completions model that emits an image (OpenRouter/Gemini style). */
async function genViaChatModalities(prov: { name: string; baseUrl?: string }, key: string, model: string, prompt: string): Promise<ImageResult> {
  const base = (prov.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/bobofbuilding/id-agent-control-center',
        'X-Title': 'ID Agents Control Center',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], modalities: ['image', 'text'] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) { let d = ''; try { d = (await r.text()).slice(0, 200); } catch { /* */ } return { ok: false, error: `image API ${r.status}${d ? `: ${d}` : ''}` }; }
    const j = (await r.json()) as Record<string, any>;
    const img = (j?.choices?.[0]?.message?.images || [])[0];
    const url: string = img?.image_url?.url || (typeof img?.image_url === 'string' ? img.image_url : '') || '';
    const m = url.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!m) return { ok: false, error: 'model returned no image (try a different image model)' };
    if (!EXT_FOR[m[1].toLowerCase()]) return { ok: false, error: `unsupported image format ${m[1]}` };
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 64) return { ok: false, error: 'model returned an empty/invalid image' };
    const { path, dataUrl } = cacheImage(buf, m[1].toLowerCase());
    const costUsd = typeof j?.usage?.cost === 'number' ? j.usage.cost : undefined;
    return { ok: true, path, dataUrl, model, costUsd, provider: prov.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Generate an image — preferring a configured LOCAL image server (free, private)
 * over the cloud (OpenRouter) provider, falling back to the cloud only if no
 * local server is set or the local attempt fails.
 */
export async function generateImage(prompt: string, model?: string): Promise<ImageResult> {
  const p = (prompt || '').trim();
  if (!p) return { ok: false, error: 'empty prompt' };

  const settings = loadSettings();
  const local = settings.imageServer;
  let localErr = '';
  // 1) Local image server first.
  if (local?.url) {
    const res = local.type === 'openai'
      ? await genViaOpenAIImages(local.url, local.model, p)
      : await genViaAuto1111(local.url.replace(/\/+$/, ''), p);
    if (res.ok) return res;
    localErr = res.error || 'local image server failed';
  }

  // 2) Cloud fallback (OpenRouter / openai-compatible).
  const prov = imageProvider();
  if (!prov) {
    return { ok: false, error: local?.url
      ? `local image server failed (${localErr}); no cloud image provider configured`
      : 'no image generator — set a local image server in Settings → Inference, or add an OpenRouter key' };
  }
  const key = resolveProviderKey(prov);
  if (!key) return { ok: false, error: `no API key for ${prov.name}` };
  const res = await genViaChatModalities(prov as any, key, model || pickImageModel(p), p);
  if (!res.ok && localErr) res.error = `local image server failed (${localErr}); cloud also failed: ${res.error}`;
  return res;
}

/** Probe localhost for a known image-generation server (Automatic1111 SD, or an
 *  OpenAI-style images API like LocalAI). Returns the first one found, or null. */
export async function detectImageServer(): Promise<ImageServerConfig | null> {
  const tryFetch = async (u: string): Promise<boolean> => {
    try { const r = await fetch(u, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
  };
  // Automatic1111 / Forge (SD WebUI) — the most common free local generator.
  for (const url of ['http://127.0.0.1:7860', 'http://127.0.0.1:7861']) {
    if (await tryFetch(`${url}/sdapi/v1/sd-models`)) return { url, type: 'auto1111' };
  }
  // OpenAI-style images API (LocalAI default 8080, or others).
  for (const url of ['http://127.0.0.1:8080', 'http://127.0.0.1:1234']) {
    if (await tryFetch(`${url}/v1/models`)) return { url, type: 'openai' };
  }
  return null;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
/** Allowed generated subtypes → cache-file extension (must match MIME above). */
const EXT_FOR: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };

/** Read a cached image back as a data URL (CSP blocks file://). Only serves files
 *  inside the chat-images cache dir, to avoid being a generic file reader. */
export function readImage(path: string): { ok: boolean; dataUrl?: string; error?: string } {
  try {
    if (!path || !existsSync(path)) return { ok: false, error: 'not found' };
    // Resolve symlinks + `..` and require containment in the cache dir, so a
    // hand-edited chat file can't turn this into a generic file reader.
    const real = realpathSync(path);
    const realDir = realpathSync(chatImagesDir());
    if (real !== realDir && !real.startsWith(realDir + sep)) return { ok: false, error: 'outside image cache' };
    if (statSync(real).size > 25 * 1024 * 1024) return { ok: false, error: 'too large' };
    const ext = (real.split('.').pop() || '').toLowerCase();
    if (!MIME[ext]) return { ok: false, error: 'not an image' };
    return { ok: true, dataUrl: `data:${MIME[ext]};base64,${readFileSync(real).toString('base64')}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The configured local image server, if any (for the Settings UI). */
export function getImageServer(): ImageServerConfig | null {
  return loadSettings().imageServer ?? null;
}

/** Whether image generation is possible at all (a local server OR a cloud
 *  provider) + the model list the cloud provider offers (best-effort). The
 *  renderer treats a non-empty result as "image generation available". */
export async function imageModels(): Promise<string[]> {
  const out: string[] = [];
  const local = loadSettings().imageServer;
  if (local?.url) out.push(`local:${local.type}`); // makes image generation available even with no cloud provider
  const prov = imageProvider();
  if (prov) {
    const key = resolveProviderKey(prov);
    const base = (prov.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    try {
      const r = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const j = (await r.json()) as Record<string, any>;
        const ids = (j?.data || [])
          .filter((m: any) => (m?.architecture?.output_modalities || []).includes('image'))
          .map((m: any) => String(m.id))
          .sort();
        out.push(...(ids.length ? ids : [DEFAULT_IMAGE_MODEL]));
      } else {
        out.push(DEFAULT_IMAGE_MODEL);
      }
    } catch {
      out.push(DEFAULT_IMAGE_MODEL);
    }
  }
  return out;
}
