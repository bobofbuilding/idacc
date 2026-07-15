import { useSyncExternalStore } from 'react';
import { cancelRootSafePairing, retryRootSafeQr, subscribeWalletConnect, walletConnectSnapshot } from '../walletConnect.ts';

export function WalletConnectPrompt() {
  const state = useSyncExternalStore(subscribeWalletConnect, walletConnectSnapshot);
  if (!state.pairingUri) return null;

  async function copyUri() {
    await navigator.clipboard.writeText(state.pairingUri).catch(() => {});
  }

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={() => void cancelRootSafePairing()}>
      <div className="modal walletconnect-modal" role="dialog" aria-modal="true" aria-labelledby="walletconnect-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title" id="walletconnect-title">Connect root Safe</div>
        <p className="muted small">
          Scan with a WalletConnect-compatible wallet or Safe. This session is reserved for provisioning or revoking agent Safes; agents use their own scoped session keys afterward.
        </p>
        <div className="walletconnect-qr">
          {state.qrDataUrl ? (
            <img src={state.qrDataUrl} alt="WalletConnect pairing QR code" />
          ) : state.error ? (
            <div className="walletconnect-qr-error">
              <span className="status-error">The QR code could not be rendered.</span>
              <button className="btn" type="button" onClick={() => void retryRootSafeQr()}>Retry QR</button>
            </div>
          ) : (
            <span className="muted">Preparing QR code...</span>
          )}
        </div>
        {state.error ? <div className="status-error small walletconnect-error">{state.error} You can still copy the pairing URI.</div> : null}
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button className="btn" type="button" onClick={() => void copyUri()}>Copy pairing URI</button>
          <button className="btn" type="button" onClick={() => void cancelRootSafePairing()}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
