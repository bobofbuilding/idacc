#!/usr/bin/env node

console.error(
  'The Tauri shell is a developer-only interface simulation and is not the '
  + 'unified IDACC application: it does not bundle or supervise Manager and Brain. '
  + 'Production installers must be built only by the Electron release workflow. '
  + 'For UI simulation work, use npm run dev:tauri-simulation.',
);
process.exit(1);
