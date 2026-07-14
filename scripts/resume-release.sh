#!/usr/bin/env bash
# Finish a release whose tag was pushed but whose GitHub Release was not created.
set -euo pipefail

VER="${1:-}"
if ! [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: scripts/release.sh --resume X.Y.Z" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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
TAG="v$VER"
cd "$ROOT"

git fetch --quiet origin --tags
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "cannot resume: $TAG does not exist locally" >&2
  exit 1
fi

node "$ROOT/scripts/check-release-publication.mjs" --allow-tag "$TAG"

WORKTREE_BASE="$(mktemp -d "${TMPDIR:-/tmp}/idacc-resume-release.XXXXXX")"
WORKTREE="$WORKTREE_BASE/source"
PENDING_TAG="$TAG"
cleanup() {
  local status=$?
  if [ -d "$WORKTREE" ]; then
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  fi
  rmdir "$WORKTREE_BASE" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ -n "${PENDING_TAG:-}" ]; then
    echo "ERROR: $PENDING_TAG is pushed but its GitHub Release was not confirmed. Fix the failure and rerun: scripts/release.sh --resume ${PENDING_TAG#v}" >&2
  fi
}
trap cleanup EXIT

# The guard itself may have been added after the orphaned tag. Build from the
# tag in an isolated worktree so the released binary always matches that tag.
git worktree add --quiet --detach "$WORKTREE" "$TAG"
export DESK="$WORKTREE/idctl-desktop"
if [ "$(node -p "require('$DESK/package.json').version")" != "$VER" ]; then
  echo "cannot resume: $TAG does not contain idctl-desktop version $VER" >&2
  exit 1
fi
node "$WORKTREE/scripts/validate-release-schema.mjs" --publish "$VER"

PENDING_TAG="$TAG"
( cd "$DESK" && npm ci )
( cd "$DESK" && npm run typecheck )
( cd "$DESK" && CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist )
APP="$DESK/release/mac-arm64/ID Agents Control Center.app"
ZIP="$DESK/release/ID-Agents-Control-Center-$VER-arm64.zip"
[ -d "$APP" ] || { echo "build did not produce $APP" >&2; exit 1; }
node "$ROOT/scripts/check-release-payload.mjs" "$APP"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

python3 "$PUB" "$VER"
node "$ROOT/scripts/check-release-publication.mjs" --require-tag "$TAG"
PENDING_TAG=""
rm -f "$ZIP"
echo "✓ resumed and published $TAG"
