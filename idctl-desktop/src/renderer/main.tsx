import './styles.css';
import { createRoot } from 'react-dom/client';
import { App, AppErrorBoundary } from './App.tsx';
import { bindStoreEvents, setTransport } from './store.ts';

// Electron shell: route data calls over the IPC bridge.
setTransport((method, args) => window.idagents.call(method, ...args));
bindStoreEvents(window.idagents);

createRoot(document.getElementById('root')!).render(<AppErrorBoundary><App /></AppErrorBoundary>);
