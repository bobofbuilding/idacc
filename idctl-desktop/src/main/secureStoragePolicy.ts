export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
}

export interface SecureStorageStatus {
  available: boolean;
  backend: string;
  error?: string;
}

function linuxBackendLabel(backend: string): string {
  if (backend === 'gnome_libsecret') return 'electron-safeStorage/Linux-Secret-Service';
  if (/^kwallet(?:5|6)?$/.test(backend)) return `electron-safeStorage/Linux-${backend}`;
  if (backend === 'basic_text') return 'electron-safeStorage/Linux-basic_text';
  return `electron-safeStorage/Linux-${backend || 'unknown'}`;
}

/**
 * Pure policy for Electron safeStorage. Linux's basic_text backend is only
 * reversible obfuscation, so it must never protect API keys or agent signers.
 */
export function evaluateSecureStorageBackend(input: {
  platform: string;
  encryptionAvailable: boolean;
  selectedBackend?: string;
}): SecureStorageStatus {
  const platform = input.platform;
  const selectedBackend = input.selectedBackend?.trim() || '';
  const backend = platform === 'darwin'
    ? 'electron-safeStorage/macOS-Keychain'
    : platform === 'win32'
      ? 'electron-safeStorage/Windows-DPAPI'
      : platform === 'linux'
        ? linuxBackendLabel(selectedBackend)
        : `electron-safeStorage/${platform || 'unknown'}${selectedBackend ? `-${selectedBackend}` : ''}`;

  if (!input.encryptionAvailable) {
    return {
      available: false,
      backend,
      error: 'Secure operating-system credential storage is unavailable.',
    };
  }
  if (platform === 'linux' && selectedBackend === 'basic_text') {
    return {
      available: false,
      backend,
      error: 'Linux safeStorage selected the insecure basic_text backend; configure Secret Service or KWallet and retry.',
    };
  }
  return { available: true, backend };
}

/** Inspect a supplied safeStorage implementation without importing Electron. */
export function secureStorageStatus(
  storage: SafeStorageLike,
  platform = process.platform,
): SecureStorageStatus {
  let encryptionAvailable = false;
  try {
    encryptionAvailable = storage.isEncryptionAvailable();
  } catch {
    return evaluateSecureStorageBackend({ platform, encryptionAvailable: false });
  }

  let selectedBackend: string | undefined;
  if (platform === 'linux') {
    try {
      selectedBackend = storage.getSelectedStorageBackend?.();
    } catch {
      selectedBackend = 'unknown';
    }
  }
  return evaluateSecureStorageBackend({ platform, encryptionAvailable, selectedBackend });
}
