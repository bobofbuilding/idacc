export const MAIN_PROCESS_STARTUP_POLICY_VERSION = 1;
export const RELEASE_LINUX_SANDBOX_EXIT_CODE = 78;
export const RELEASE_LINUX_SANDBOX_TITLE =
  'IDACC Linux sandbox requirement';
export const RELEASE_LINUX_SANDBOX_GUIDANCE =
  'IDACC refused to start because Electron sandbox protection was disabled. '
  + 'Install the IDACC .deb package or enable unprivileged user namespaces, '
  + 'then launch again without --no-sandbox or --disable-setuid-sandbox.';

const MODES = new Set(['development', 'review', 'production']);

export function mainProcessStartupPolicyMode({
  releaseBuild,
  reviewBuild,
}) {
  if (!releaseBuild) return 'development';
  return reviewBuild ? 'review' : 'production';
}

export function mainProcessStartupPolicyMarker(mode) {
  if (!MODES.has(mode)) {
    throw new Error('main-process startup policy mode is invalid');
  }
  return `idacc-main-startup-policy:${mode}:v${MAIN_PROCESS_STARTUP_POLICY_VERSION}`;
}

export function mainProcessStartupBanner(mode) {
  const marker = mainProcessStartupPolicyMarker(mode);
  const releaseGuard = mode !== 'development';
  const policy = releaseGuard
    ? `if(process.platform==="linux"){const r=/^--(?:no-sandbox|disable-setuid-sandbox)(?:=|$)/i;let blocked=Array.isArray(process.argv)&&process.argv.some((value)=>r.test(String(value)));let electron=null;let electronReady=true;try{electron=require("electron");const application=electron&&electron.app;const commandLine=application&&application.commandLine;if(!application||typeof application.enableSandbox!=="function"||!commandLine||typeof commandLine.hasSwitch!=="function")electronReady=false;else blocked=blocked||commandLine.hasSwitch("no-sandbox")||commandLine.hasSwitch("disable-setuid-sandbox");}catch{electronReady=false;}if(blocked||!electronReady){const title=${JSON.stringify(RELEASE_LINUX_SANDBOX_TITLE)};const guidance=${JSON.stringify(RELEASE_LINUX_SANDBOX_GUIDANCE)};try{process.stderr.write(title+": "+guidance+"\\n");}catch{}try{if(electron&&electron.dialog&&typeof electron.dialog.showErrorBox==="function")electron.dialog.showErrorBox(title,guidance);}catch{}process.exitCode=${RELEASE_LINUX_SANDBOX_EXIT_CODE};process.exit(${RELEASE_LINUX_SANDBOX_EXIT_CODE});}electron.app.enableSandbox();}`
    : '';
  return `/* ${marker} */\n(()=>{${policy}})();\n`;
}
