#!/usr/bin/env bash
#
# Canonical IDACC release command.
#
#   scripts/release.sh "<changelog note>"
#   scripts/release.sh "<changelog note>" 0.2.0
#   scripts/release.sh "<changelog note>" --publish=false
#   scripts/release.sh --resume 0.2.0 --publish=true
#
# A normal release prepares one versioned application commit, creates a signed
# annotated tag, pushes that exact commit and tag atomically, waits for GitHub
# to report verification.verified=true, and dispatches the cross-platform
# Production release workflow. --publish=false exercises the same production
# build and verification path but leaves the GitHub Release as a draft.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESK="$ROOT/idctl-desktop"
TUI="$ROOT/idctl"
export DESK TUI

# shellcheck source=scripts/lib/release-command.sh
source "$ROOT/scripts/lib/release-command.sh"

usage() {
  cat >&2 <<'EOF'
usage:
  scripts/release.sh "<changelog note>" [X.Y.Z] [--publish=true|false]
  scripts/release.sh --resume X.Y.Z [--publish=true|false]
EOF
  exit 2
}

if [ "${1:-}" = "--resume" ]; then
  shift
  exec bash "$ROOT/scripts/resume-release.sh" "$@"
fi

NOTE="${1:-}"
[ -n "$NOTE" ] || usage
shift

PUBLISH="true"
VER_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --publish=true) PUBLISH="true" ;;
    --publish=false) PUBLISH="false" ;;
    --commit|--commit-only|--no-publish)
      release_fail "$1 is retired; use --publish=false to run the complete cross-platform workflow and retain a draft"
      ;;
    --*) usage ;;
    *)
      [ -z "$VER_ARG" ] || release_fail "multiple explicit versions were supplied"
      VER_ARG="$1"
      ;;
  esac
  shift
done

if printf '%s' "$NOTE" | grep -Eiq '^(automated release of outstanding|maintenance release\.?$|update\.?$|changes\.?$|misc\.?$|wip\.?$)'; then
  release_fail "release note must describe what changed; placeholder summaries are not allowed"
fi

cd "$ROOT"

# Authentication and signing are preflighted before any versioned file is
# changed. A missing credential can therefore never leave a half-prepared
# release commit behind.
release_require_gh_auth
REPOSITORY="$(release_github_repository)"
export GH_TOKEN="${GH_TOKEN:-$(gh auth token --hostname github.com)}"

[ "$(git branch --show-current)" = "main" ] \
  || release_fail "new releases must be prepared from the main branch"
git fetch --quiet origin main --tags
PUBLICATION_STATE="$(node "$ROOT/scripts/check-release-publication.mjs" --json)"
CHANGELOG_BASELINE="$(node -e '
const state = JSON.parse(process.argv[1]);
if (typeof state.changelogBaselineTag !== "string") process.exit(1);
process.stdout.write(state.changelogBaselineTag);
' "$PUBLICATION_STATE")"
CUTOVER_VERSION_FLOOR="$(node -e '
const state = JSON.parse(process.argv[1]);
if (typeof state.firstCanonicalVersionMustExceed !== "string") process.exit(1);
process.stdout.write(state.firstCanonicalVersionMustExceed);
' "$PUBLICATION_STATE")"
git rev-parse -q --verify "${CHANGELOG_BASELINE}^{commit}" >/dev/null \
  || release_fail "published changelog baseline $CHANGELOG_BASELINE is not available locally"

SIGNING_PREFLIGHT_TAG="idacc-release-signing-preflight-$$"
cleanup_signing_preflight() {
  git tag -d "$SIGNING_PREFLIGHT_TAG" >/dev/null 2>&1 || true
}
trap cleanup_signing_preflight EXIT
git tag -s -a "$SIGNING_PREFLIGHT_TAG" HEAD -m "IDACC release signing preflight" \
  || release_fail "cannot create a signed tag; configure a Git signing key registered with GitHub"
release_assert_local_signed_tag "$SIGNING_PREFLIGHT_TAG" "$(git rev-parse HEAD)"
cleanup_signing_preflight
trap - EXIT

strip_version_subject() {
  printf '%s' "$1" | sed -E 's/^v[0-9]+\.[0-9]+\.[0-9]+: *//'
}

summarize_placeholder_commit() {
  local commit="$1"
  local file
  local extra
  local suffix
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

CUR="$(node -p "require('$DESK/package.json').version")"
if ! [[ "$CUR" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  release_fail "current application version is not plain semver: $CUR"
fi
VER="${VER_ARG:-$(node -e "const [a,b,c]=process.argv[1].split('.'); console.log(\`\${a}.\${b}.\${Number(c)+1}\`)" "$CUR")}"
if ! [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  release_fail "release version must be plain semver X.Y.Z; got $VER"
fi
node -e '
const current = process.argv[1].split(".").map(Number);
const next = process.argv[2].split(".").map(Number);
for (let index = 0; index < 3; index += 1) {
  if (next[index] > current[index]) process.exit(0);
  if (next[index] < current[index]) process.exit(1);
}
process.exit(1);
' "$CUR" "$VER" || release_fail "release version $VER must be greater than current version $CUR"
node -e '
const candidate = process.argv[1].slice(1).split(".").map(Number);
const floor = process.argv[2].slice(1).split(".").map(Number);
for (let index = 0; index < 3; index += 1) {
  if (candidate[index] > floor[index]) process.exit(0);
  if (candidate[index] < floor[index]) process.exit(1);
}
process.exit(1);
' "v$VER" "$CUTOVER_VERSION_FLOOR" \
  || release_fail "release version v$VER must be greater than audited legacy cutoff $CUTOVER_VERSION_FLOOR"

printf '▶ preparing v%s from v%s (publish=%s)\n' "$VER" "$CUR" "$PUBLISH"

RANGE="${CHANGELOG_BASELINE}..HEAD"
PRIMARY_NOTE="$(strip_version_subject "$NOTE")"
[ -n "$PRIMARY_NOTE" ] || release_fail "release note must describe what changed"
CHANGELOG_LINES=("$PRIMARY_NOTE")
append_changelog_line() {
  local candidate="$1"
  local existing
  for existing in "${CHANGELOG_LINES[@]}"; do
    [ "$candidate" = "$existing" ] && return
  done
  CHANGELOG_LINES+=("$candidate")
}
CHANGELOG_COMMITS="$(git log "$RANGE" --no-merges --format='%H%x09%s')" \
  || release_fail "cannot read complete changelog history from published baseline $CHANGELOG_BASELINE"
while IFS=$'\t' read -r commit subject; do
  [ -n "$commit" ] || continue
  note="$(normalize_release_subject "$commit" "$subject")" || continue
  [ -n "$note" ] || continue
  append_changelog_line "$note"
done <<< "$CHANGELOG_COMMITS"
CHANGELOG_BODY="$(printf '%s\n' "${CHANGELOG_LINES[@]}")"
if [ -z "$CHANGELOG_BODY" ]; then
  release_fail "release note must describe what changed"
fi
if printf '%s' "$CHANGELOG_BODY" | grep -Eiq '^(automated release of outstanding|maintenance release\.?$|update\.?$|changes\.?$|misc\.?$|wip\.?$)'; then
  release_fail "release note/changelog body must describe real changes"
fi
printf '▶ changelog for v%s (from published %s):\n%s\n' "$VER" "$CHANGELOG_BASELINE" "$CHANGELOG_BODY"

# Fail before mutation when the application does not typecheck.
( cd "$DESK" && npm run typecheck )

node -e '
const fs = require("fs");
const path = require("path");
const [version] = process.argv.slice(1);
function updatePackageJson(file) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = version;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
function updateLock(file) {
  if (!fs.existsSync(file)) return;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.version = version;
  if (json.packages?.[""]) json.packages[""].version = version;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
}
for (const directory of [process.env.DESK, process.env.TUI]) {
  updatePackageJson(path.join(directory, "package.json"));
  updateLock(path.join(directory, "package-lock.json"));
}
' "$VER"

node -e '
const fs = require("fs");
const [version, note] = process.argv.slice(1);
const file = "CHANGELOG.md";
const text = fs.readFileSync(file, "utf8");
const date = new Date().toISOString().slice(0, 10);
const body = note.trim().split("\n").map((line) => line.trim()).filter(Boolean)
  .map((line) => (line.startsWith("-") ? line : `- ${line}`)).join("\n");
const entry = `## [${version}] — ${date}\n### What changed\n${body}\n\n`;
const index = text.indexOf("## [");
fs.writeFileSync(file, index >= 0 ? text.slice(0, index) + entry + text.slice(index) : `${text}\n${entry}`);
' "$VER" "$CHANGELOG_BODY"

node "$ROOT/scripts/validate-release-schema.mjs" --precommit "$VER"

SUBJECT="$(printf '%s' "$CHANGELOG_BODY" | head -1 | sed -E 's/^- *//')"
git add -A
git commit -q -m "v$VER: $SUBJECT"
git pull --rebase origin main
node "$ROOT/scripts/validate-release-schema.mjs" --postcommit "$VER"
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] \
  || release_fail "release checkout is not clean after preparing the version commit"

TAG="v$VER"
RELEASE_COMMIT="$(git rev-parse HEAD)"
git tag -s -a "$TAG" "$RELEASE_COMMIT" -m "$TAG: $SUBJECT"
release_assert_local_signed_tag "$TAG" "$RELEASE_COMMIT"
node "$ROOT/scripts/validate-release-schema.mjs" --publish "$VER"
TAG_OBJECT="$(git rev-parse "refs/tags/$TAG")"

PUSHED_TAG=""
on_exit() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "${PUSHED_TAG:-}" ]; then
    printf 'ERROR: %s is on GitHub but the Production release workflow was not safely confirmed. Resume with: scripts/release.sh --resume %s --publish=%s\n' \
      "$PUSHED_TAG" "$VER" "$PUBLISH" >&2
  fi
}
trap on_exit EXIT

# GitHub supports atomic pushes. Either the exact prepared commit and its signed
# tag both become visible, or neither does.
git push --atomic origin \
  "$RELEASE_COMMIT:refs/heads/main" \
  "refs/tags/$TAG:refs/tags/$TAG"
PUSHED_TAG="$TAG"

REMOTE_MAIN="$(git ls-remote --refs origin refs/heads/main | awk 'NR == 1 { print $1 }')"
[ "$REMOTE_MAIN" = "$RELEASE_COMMIT" ] \
  || release_fail "origin/main moved to ${REMOTE_MAIN:-nothing}; expected $RELEASE_COMMIT"
release_assert_remote_tag "$TAG" "$TAG_OBJECT" "$RELEASE_COMMIT"
release_wait_for_github_verified_tag "$REPOSITORY" "$TAG" "$RELEASE_COMMIT"

bash "$ROOT/scripts/resume-release.sh" "$VER" "--publish=$PUBLISH"
PUSHED_TAG=""
trap - EXIT

printf '✓ prepared and dispatched %s from exact commit %s (publish=%s)\n' "$TAG" "$RELEASE_COMMIT" "$PUBLISH"
