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
#        → build the macOS app → zip → tag vX.Y.Z → push origin main --tags → publish
#        the GitHub release asset (via ../release-publish.py, which reuses the deployer PAT)
#        → delete local release zips after upload verification.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # repo root: …/.iacc-publish/id-agent-control-center
export DESK="$ROOT/idctl-desktop"          # exported so the inline node helpers can read it
export TUI="$ROOT/idctl"

resolve_publisher() {
  local candidate
  for candidate in \
    "${IDACC_RELEASE_PUBLISHER:-}" \
    "$ROOT/../release-publish.py" \
    "$ROOT/../../../../.iacc-publish/release-publish.py"
  do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if ! PUB="$(resolve_publisher)"; then
  echo "release publisher not found; set IDACC_RELEASE_PUBLISHER to release-publish.py" >&2
  exit 1
fi
cd "$ROOT"

if [ "${1:-}" = "--resume" ]; then
  exec bash "$ROOT/scripts/resume-release.sh" "${2:-}"
fi

NOTE="${1:-}"
if [ -z "$NOTE" ]; then
  echo "usage: scripts/release.sh \"<changelog note>\" [explicit-version] [--commit] | scripts/release.sh --resume X.Y.Z" >&2
  exit 1
fi
if printf '%s' "$NOTE" | grep -Eiq '^(automated release of outstanding|maintenance release\.?$|update\.?$|changes\.?$|misc\.?$|wip\.?$)'; then
  echo "release note must describe what changed; placeholder summaries are not allowed" >&2
  exit 1
fi

strip_version_subject() {
  printf '%s' "$1" | sed -E 's/^v[0-9]+\.[0-9]+\.[0-9]+: *//'
}

summarize_placeholder_commit() {
  local commit="$1"
  local file extra suffix
  local -a files=()
  local -a meaningful=()

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    files+=("$file")
    case "$file" in
      CHANGELOG.md|idctl/package.json|idctl/package-lock.json|idctl-desktop/package.json|idctl-desktop/package-lock.json)
        ;;
      *)
        meaningful+=("$file")
        ;;
    esac
  done < <(git show --name-only --format='' "$commit" 2>/dev/null)

  if [ "${#meaningful[@]}" -gt 0 ]; then
    files=("${meaningful[@]}")
  fi

  case "${#files[@]}" in
    0) return 1 ;;
    1) printf 'Outstanding changes in %s.' "${files[0]}" ;;
    2) printf 'Outstanding changes in %s and %s.' "${files[0]}" "${files[1]}" ;;
    3) printf 'Outstanding changes across %s, %s, and %s.' "${files[0]}" "${files[1]}" "${files[2]}" ;;
    *)
      extra=$((${#files[@]} - 3))
      suffix="s"
      [ "$extra" -eq 1 ] && suffix=""
      printf 'Outstanding changes across %s, %s, %s, and %d more file%s.' "${files[0]}" "${files[1]}" "${files[2]}" "$extra" "$suffix"
      ;;
  esac
}

normalize_release_subject() {
  local commit="$1"
  local stripped
  stripped="$(strip_version_subject "$2")"

  case "$stripped" in
    "chore(auto-release): capture outstanding WIP for the next release"|"Automated release of outstanding ID Agents Control Center code."|"Automated release of outstanding ID Agents Control Center code")
      summarize_placeholder_commit "$commit" || printf '%s' "$stripped"
      ;;
    chore:\ bump*|chore\(release\)*)
      return 1
      ;;
    *)
      printf '%s' "$stripped"
      ;;
  esac
}

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

# A prior local run can push its tag and then fail during the build or publish.
# Never create another version while that gap exists; it must be resumed first.
node "$ROOT/scripts/check-release-publication.mjs"

PUSHED_TAG=""
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "${PUSHED_TAG:-}" ]; then
    echo "ERROR: $PUSHED_TAG was pushed but its GitHub Release was not confirmed. Fix the failure and rerun: scripts/release.sh --resume ${PUSHED_TAG#v}" >&2
  fi
}
trap on_exit EXIT

# --- derive the CHANGELOG body from the REAL commits since the last release tag, so the
#     entry reflects TRUE contents — every feature/fix in this release, not a single passed
#     note. Strip the off-by-one "vX.Y.Z:" hook prefix, drop housekeeping commits, and
#     synthesize a diff-based summary when the only subject is the auto-release WIP placeholder.
#     (Computed from local HEAD BEFORE the bump commit; the node step below bullets each line.) ---
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
RANGE="${LAST_TAG:+${LAST_TAG}..}HEAD"
CHANGELOG_LINES=()
while IFS=$'\t' read -r commit subject; do
  [ -n "$commit" ] || continue
  note="$(normalize_release_subject "$commit" "$subject")" || continue
  [ -n "$note" ] || continue
  CHANGELOG_LINES+=("$note")
done < <(git log "$RANGE" --no-merges --format='%H%x09%s' 2>/dev/null || true)
if [ "${#CHANGELOG_LINES[@]}" -gt 0 ]; then
  CHANGELOG_BODY="$(printf '%s\n' "${CHANGELOG_LINES[@]}")"
else
  CHANGELOG_BODY=""
fi
if [ -z "$CHANGELOG_BODY" ]; then
  CHANGELOG_BODY="$(strip_version_subject "$NOTE")"
fi
if [ -z "$CHANGELOG_BODY" ]; then
  echo "release note must describe what changed; refusing to create a generic release" >&2
  exit 1
fi
if printf '%s' "$CHANGELOG_BODY" | grep -Eiq '^(automated release of outstanding|maintenance release\.?$|update\.?$|changes\.?$|misc\.?$|wip\.?$)'; then
  echo "release note/changelog body must describe what changed; got placeholder text:" >&2
  printf '%s\n' "$CHANGELOG_BODY" >&2
  exit 1
fi
printf '▶ changelog for v%s (from %s):\n%s\n' "$VER" "${RANGE}" "$CHANGELOG_BODY"

# --- 0) typecheck FIRST, before mutating anything — a failure leaves the tree pristine ---
( cd "$DESK" && npm run typecheck )

# --- 1) bump the version in package manifests + lockfile roots ---
node -e '
const fs = require("fs"); const path = require("path"); const [ver] = process.argv.slice(1);
function updatePackageJson(file) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = ver;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
function updateLock(file) {
  if (!fs.existsSync(file)) return;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = ver;
  if (json.packages?.[""]) json.packages[""].version = ver;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
for (const dir of [process.env.DESK, process.env.TUI]) {
  updatePackageJson(path.join(dir, "package.json"));
  updateLock(path.join(dir, "package-lock.json"));
}
' "$VER"

# --- 2) prepend a CHANGELOG entry under the title block (before the first "## [" heading) ---
node -e '
const fs = require("fs"); const [ver, note] = process.argv.slice(1);
const f = "CHANGELOG.md"; const t = fs.readFileSync(f, "utf8");
const date = new Date().toISOString().slice(0, 10);
const body = note.trim().split("\n").map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith("-") ? l : "- " + l)).join("\n");
const entry = `## [${ver}] — ${date}\n### What changed\n${body}\n\n`;
const i = t.indexOf("## [");
fs.writeFileSync(f, (i >= 0 ? t.slice(0, i) + entry + t.slice(i) : t + "\n" + entry));
' "$VER" "$CHANGELOG_BODY"

node "$ROOT/scripts/validate-release-schema.mjs" --precommit "$VER"

# --- 3) commit, then build before exposing a release tag remotely ---
# Stamp the version onto the subject ourselves (the commit-msg hook is idempotent and leaves a
# "v…"-prefixed subject untouched — so this works whether or not the hook is installed in this clone).
SUBJECT="$(printf '%s' "$CHANGELOG_BODY" | head -1 | sed -E 's/^- *//')"
git add -A
git commit -q -m "v$VER: $SUBJECT"
git pull --rebase origin main   # fold in any concurrent agent pushes before we publish (fail-stops on conflict)
node "$ROOT/scripts/validate-release-schema.mjs" --postcommit "$VER"

# A build failure must not leave a remotely visible release tag behind. The
# explicit --commit path intentionally skips this build and leaves a deferred
# tag that the preflight will force the next release to resolve.
if [ "$COMMIT_ONLY" != "1" ]; then
  ( cd "$DESK" && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist )
  APP="$DESK/release/mac-arm64/ID Agents Control Center.app"
  ZIP="$DESK/release/ID-Agents-Control-Center-$VER-arm64.zip"
  [ -d "$APP" ] || { echo "build did not produce $APP" >&2; exit 1; }
  node "$ROOT/scripts/check-release-payload.mjs" "$APP"
  rm -f "$ZIP"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
fi

# --- 4) tag + push only after the full-release artifact is ready ---
git tag "v$VER"
node "$ROOT/scripts/validate-release-schema.mjs" --publish "$VER"
git push origin main --tags
PUSHED_TAG="v$VER"
echo "✓ committed + tagged v$VER + pushed to origin/main"

if [ "$COMMIT_ONLY" = "1" ]; then
  echo "✓ --commit: stopped before build/publish. Publish this deferred tag before cutting another version: scripts/release.sh --resume $VER"
  PUSHED_TAG=""
  exit 0
fi

# --- 5) publish the GitHub release (creates the v$VER release + uploads + verifies the asset) ---
export DESK
python3 "$PUB" "$VER"
node "$ROOT/scripts/check-release-publication.mjs" --require-tag "v$VER"
PUSHED_TAG=""

# The tag was already pushed in step 3 (git log/CHANGELOG/tag all agree the version shipped);
# confirm the GitHub release itself actually landed before we call this a success and delete the
# local build evidence — release-publish.py failing/partially-succeeding after this point is exactly
# how a tag+commit can go out with no matching GitHub release (see v0.1.637).
node "$ROOT/scripts/check-release-published.mjs" "$VER"

# Local zips are upload scratch space only; GitHub releases are the durable archive.
node -e '
const fs = require("fs");
const path = require("path");
const dir = path.join(process.env.DESK, "release");
let count = 0;
let bytes = 0;
if (fs.existsSync(dir)) {
  for (const name of fs.readdirSync(dir)) {
    if (!/^ID-Agents-Control-Center-\d+\.\d+\.\d+(?:-mac)?-arm64\.zip$/.test(name)) continue;
    const file = path.join(dir, name);
    const st = fs.statSync(file);
    if (!st.isFile()) continue;
    count += 1;
    bytes += st.size;
    fs.unlinkSync(file);
  }
}
const gib = (bytes / 1024 / 1024 / 1024).toFixed(2);
console.log(count ? `✓ cleaned ${count} local release zip(s), freed ${gib} GiB` : "✓ no local release zips to clean");
'
echo "✓ released v$VER"
