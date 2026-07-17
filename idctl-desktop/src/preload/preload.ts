/**
 * Preload: exposes a tiny, safe `window.idagents` API to the renderer. The
 * renderer can only invoke the allowlisted bridge methods — no Node, no direct
 * network, no fs.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { StoreChangeEvent } from '../shared/syncDomains.ts';

export interface IdAgentsApi {
  call<T = unknown>(method: string, ...args: unknown[]): Promise<{ ok: boolean; result?: T; error?: string }>;
  /** Write user-selected text without exposing clipboard reads to the renderer. */
  copyText(value: string): Promise<boolean>;
  /** Subscribe to dashboard/work-store invalidation pushes from the main process. */
  onStoreChange(cb: (event: StoreChangeEvent) => void): () => void;
  /** Subscribe to self-update status pushes from the main process. Returns an unsubscribe fn. */
  onUpdateStatus(cb: (status: unknown) => void): () => void;
  /** Subscribe to Ollama model-pull progress. Returns an unsubscribe fn. */
  onOllamaPull(cb: (progress: unknown) => void): () => void;
  /** Subscribe to live Computer Use frames from the broker. Returns an unsubscribe fn. */
  onComputerFrame(cb: (frame: unknown) => void): () => void;
  /** Subscribe to Computer Use approval prompts (supervised mode). Returns an unsubscribe fn. */
  onComputerPending(cb: (evt: unknown) => void): () => void;
  /** Subscribe to a PANIC (global hotkey) so the view can reflect it. Returns an unsubscribe fn. */
  onComputerPanic(cb: (evt: unknown) => void): () => void;
}

const api: IdAgentsApi = {
  call: (method, ...args) => ipcRenderer.invoke('idagents:call', method, args),
  copyText: (value) => ipcRenderer.invoke('idagents:clipboardWrite', value),
  onStoreChange: (cb) => {
    const listener = (_e: unknown, event: StoreChangeEvent) => cb(event);
    ipcRenderer.on('idagents:sync', listener);
    return () => ipcRenderer.removeListener('idagents:sync', listener);
  },
  onUpdateStatus: (cb) => {
    const listener = (_e: unknown, status: unknown) => cb(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  onOllamaPull: (cb) => {
    const listener = (_e: unknown, progress: unknown) => cb(progress);
    ipcRenderer.on('ollama:pull-progress', listener);
    return () => ipcRenderer.removeListener('ollama:pull-progress', listener);
  },
  onComputerFrame: (cb) => {
    const listener = (_e: unknown, frame: unknown) => cb(frame);
    ipcRenderer.on('computeruse:frame', listener);
    return () => ipcRenderer.removeListener('computeruse:frame', listener);
  },
  onComputerPending: (cb) => {
    const listener = (_e: unknown, evt: unknown) => cb(evt);
    ipcRenderer.on('computeruse:pending', listener);
    return () => ipcRenderer.removeListener('computeruse:pending', listener);
  },
  onComputerPanic: (cb) => {
    const listener = (_e: unknown, evt: unknown) => cb(evt);
    ipcRenderer.on('computeruse:panic', listener);
    return () => ipcRenderer.removeListener('computeruse:panic', listener);
  },
};

contextBridge.exposeInMainWorld('idagents', api);
