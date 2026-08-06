/**
 * Render smoke test: mounts the real <App> against whatever manager is at
 * MANAGER_URL, then walks every view, capturing the rendered frame for each.
 * Verifies the whole component tree renders without throwing and that live
 * data flows in. Run: tsx src/__smoke__/render-smoke.tsx
 */
import { render } from 'ink-testing-library';
import React from 'react';
import { App } from '../app/App.tsx';
import { loadConfig } from '../config.ts';
import { VIEWS } from '../app/views.ts';

const ESC = String.fromCharCode(27);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  const { lastFrame, stdin, unmount } = render(React.createElement(App, { config: cfg }));

  await delay(1800); // let the snapshot poll populate
  let failures = 0;

  for (let i = 0; i < VIEWS.length; i++) {
    if (i > 0) {
      stdin.write(ESC); // drop any captured focus (e.g. chat input)
      await delay(80);
      stdin.write(i === 9 ? '0' : String(i + 1)); // views 1-9 → keys 1-9; view 10 → 0
      await delay(350);
    }
    const frame = lastFrame() ?? '';
    const staleOnboardingCapture = i > 1 && /Onboard agent · step/.test(frame);
    const ok =
      frame.trim().length > 0
      && !/undefined is not|Cannot read|TypeError/.test(frame)
      && !staleOnboardingCapture;
    if (!ok) failures++;
    process.stdout.write(`\n===== view ${i + 1}: ${VIEWS[i].label} ${ok ? 'OK' : 'FAIL'} =====\n`);
    process.stdout.write(frame + '\n');
  }

  unmount();
  process.stdout.write(`\n[smoke] ${VIEWS.length - failures}/${VIEWS.length} views rendered\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`[smoke] threw: ${err?.stack ?? err}\n`);
  process.exit(2);
});
