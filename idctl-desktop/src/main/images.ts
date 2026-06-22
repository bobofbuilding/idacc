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

/** The provider used for image generation: prefer OpenRouter, else any enabled
 *  openai-compatible/openai provider. */
function imageProvider() {
  const ps = (loadSettings().providers ?? []).filter((p) => p.enabled !== false);
  return ps.find((p) => p.name === 'openrouter') || ps.find((p) => p.kind === 'openai-compatible' || p.kind === 'openai');
}

export interface ImageResult { ok: boolean; path?: string; dataUrl?: string; model?: string; costUsd?: number; provider?: string; error?: string }

export async function generateImage(prompt: string, model?: string): Promise<ImageResult> {
  const p = (prompt || '').trim();
  if (!p) return { ok: false, error: 'empty prompt' };
  const prov = imageProvider();
  if (!prov) return { ok: false, error: 'no image-capable provider — add an OpenRouter key in Settings → Inference' };
  const key = resolveProviderKey(prov);
  if (!key) return { ok: false, error: `no API key for ${prov.name}` };
  const base = (prov.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const mdl = model || pickImageModel(p); // auto-routed from the prompt when not specified
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/bobofbuilding/id-agent-control-center',
        'X-Title': 'ID Agents Control Center',
      },
      body: JSON.stringify({ model: mdl, messages: [{ role: 'user', content: p }], modalities: ['image', 'text'] }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
      return { ok: false, error: `image API ${r.status}${detail ? `: ${detail}` : ''}` };
    }
    const j = (await r.json()) as Record<string, any>;
    const img = (j?.choices?.[0]?.message?.images || [])[0];
    const url: string = img?.image_url?.url || (typeof img?.image_url === 'string' ? img.image_url : '') || '';
    const m = url.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (!m) return { ok: false, error: 'model returned no image (try a different image model)' };
    // Only persist subtypes readImage() can serve, so the cached file is never stranded.
    const ext = EXT_FOR[m[1].toLowerCase()];
    if (!ext) return { ok: false, error: `unsupported image format ${m[1]}` };
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length < 64) return { ok: false, error: 'model returned an empty/invalid image' };
    const name = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const path = join(chatImagesDir(), name);
    writeFileSync(path, buf, { mode: 0o600 });
    const costUsd = typeof j?.usage?.cost === 'number' ? j.usage.cost : undefined;
    return { ok: true, path, dataUrl: url, model: mdl, costUsd, provider: prov.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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

/** Image-output models the provider offers (for the UI picker); best-effort. */
export async function imageModels(): Promise<string[]> {
  const prov = imageProvider();
  if (!prov) return [];
  const key = resolveProviderKey(prov);
  const base = (prov.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return [DEFAULT_IMAGE_MODEL];
    const j = (await r.json()) as Record<string, any>;
    const ids = (j?.data || [])
      .filter((m: any) => (m?.architecture?.output_modalities || []).includes('image'))
      .map((m: any) => String(m.id))
      .sort();
    return ids.length ? ids : [DEFAULT_IMAGE_MODEL];
  } catch {
    return [DEFAULT_IMAGE_MODEL];
  }
}
