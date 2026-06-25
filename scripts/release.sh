#!/usr/bin/env bash
#
# One-command release for the ID Agents Control Center.
#
#   scripts/release.sh "<changelog note>"            # bump the PATCH version + ship
#   scripts/release.sh "<changelog note>" 0.2.0      # ship an explicit version
#   scripts/release.sh "<changelog note>" --commit   # stop after push (no build/publish)
#
# It follows the repo convention (CONTRIBUTING.md): the new version lives in
# idctl-desktop/package.json, the commit-msg hook stamps "vX.Y.Z:" onto the subject,
# CHANGELOG.md gets a matching "## [X.Y.Z]" entry, and the tag + GitHub release agree.
#
# Steps: bump version → CHANGELOG entry → typecheck → commit (hook stamps the version)
#        → tag vX.Y.Z → push origin main --tags → build the macOS app → zip → publish
#        the GitHub release asset (via ../release-publish.py, which reuses the deployer PAT).
set -euo pipefail

NOTE="${1:-}"
if [ -z "$NOTE" ]; then
  echo "usage: scripts/release.sh \"<changelog note>\" [explicit-version] [--commit]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # repo root: …/.iacc-publish/id-agent-control-center
export DESK="$ROOT/idctl-desktop"          # exported so the inline node helpers can read it
PUB="$ROOT/../release-publish.py"
cd "$ROOT"

# --- resolve the new version (explicit 2nd arg, else bump the patch of the current one) ---
COMMIT_ONLY=0
VER_ARG=""
for a in "${2:-}" "${3:-}"; do
  case "$a" in
    --commit|--commit-only|--no-publish) COMMIT_ONLY=1 ;;
    "" ) ;;
    * ) VER_ARG="$a" ;;
  esac
done
CUR="$(node -p "require('$DESK/package.json').version")"
VER="${VER_ARG:-$(node -e "const [a,b,c]=process.argv[1].split('.'); console.log(\`\${a}.\${b}.\${Number(c)+1}\`)" "$CUR")}"
echo "▶ releasing v$VER  (was v$CUR)"

# --- 1) bump the version in package.json + package-lock.json (first match, keep formatting) ---
node -e '
const fs = require("fs"); const [cur, ver] = process.argv.slice(1);
for (const f of [process.env.DESK + "/package.json", process.env.DESK + "/package-lock.json"]) {
  const s = fs.readFileSync(f, "utf8");
  fs.writeFileSync(f, s.replace(`"version": "${cur}"`, `"version": "${ver}"`)); // String.replace = first occurrence (the top-level field)
}
' "$CUR" "$VER"

# --- 2) prepend a CHANGELOG entry under the title block (before the first "## [" heading) ---
node -e '
const fs = require("fs"); const [ver, note] = process.argv.slice(1);
const f = "CHANGELOG.md"; const t = fs.readFileSync(f, "utf8");
const date = new Date().toISOString().slice(0, 10);
const body = note.trim().split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith("-") ? l : "- " + l)).join("\n");
const entry = `## [${ver}] — ${date}\n${body}\n\n`;
const i = t.indexOf("## [");
fs.writeFileSync(f, (i >= 0 ? t.slice(0, i) + entry + t.slice(i) : t + "\n" + entry));
' "$VER" "$NOTE"

# --- 3) typecheck (a broken build never gets shipped), then commit + tag + push ---
( cd "$DESK" && npm run typecheck )
# Stamp the version onto the subject ourselves (the commit-msg hook is idempotent and leaves a
# "v…"-prefixed subject untouched — so this works whether or not the hook is installed in this clone).
SUBJECT="$(printf '%s' "$NOTE" | head -1)"
git add -A
git commit -q -m "v$VER: $SUBJECT"
git pull --rebase origin main   # fold in any concurrent agent pushes before we publish (fail-stops on conflict)
git tag "v$VER"
git push origin main --tags
echo "✓ committed + tagged v$VER + pushed to origin/main"

if [ "$COMMIT_ONLY" = "1" ]; then
  echo "✓ --commit: stopped before build/publish (no GitHub release asset)."
  exit 0
fi

# --- 4) build the macOS app + zip it as the release asset ---
( cd "$DESK" && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist )
APP="$DESK/release/mac-arm64/ID Agents Control Center.app"
ZIP="$DESK/release/ID-Agents-Control-Center-$VER-arm64.zip"
[ -d "$APP" ] || { echo "build did not produce $APP" >&2; exit 1; }
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

# --- 5) publish the GitHub release (creates the v$VER release + uploads + verifies the asset) ---
export DESK
python3 "$PUB" "$VER"
echo "✓ released v$VER"
