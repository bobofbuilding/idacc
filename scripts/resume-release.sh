#!/usr/bin/env bash
# Safely dispatch or continue the canonical cross-platform release for an
# existing signed, GitHub-verified application tag.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/release-command.sh
source "$ROOT/scripts/lib/release-command.sh"

usage() {
  printf 'usage: scripts/release.sh --resume X.Y.Z [--publish=true|false]\n' >&2
  exit 2
}

VER="${1:-}"
shift || true
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage

PUBLISH="true"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --publish=true) PUBLISH="true" ;;
    --publish=false) PUBLISH="false" ;;
    *) usage ;;
  esac
  shift
done

cd "$ROOT"
release_require_gh_auth
REPOSITORY="$(release_github_repository)"
export GH_TOKEN="${GH_TOKEN:-$(gh auth token --hostname github.com)}"

TAG="v$VER"
git fetch --quiet origin main --tags
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || release_fail "cannot resume because $TAG does not exist"

RELEASE_COMMIT="$(git rev-list -n 1 "$TAG")"
TAG_OBJECT="$(git rev-parse "refs/tags/$TAG")"
release_assert_local_signed_tag "$TAG" "$RELEASE_COMMIT"
release_assert_remote_tag "$TAG" "$TAG_OBJECT" "$RELEASE_COMMIT"

REMOTE_MAIN="$(git ls-remote --refs origin refs/heads/main | awk 'NR == 1 { print $1 }')"
if [ "$REMOTE_MAIN" != "$RELEASE_COMMIT" ] && ! git merge-base --is-ancestor "$RELEASE_COMMIT" "$REMOTE_MAIN"; then
  release_fail "$TAG commit $RELEASE_COMMIT is not contained in origin/main $REMOTE_MAIN"
fi

WORKTREE_BASE="$(mktemp -d "${TMPDIR:-/tmp}/idacc-resume-release.XXXXXX")"
WORKTREE="$WORKTREE_BASE/source"
cleanup() {
  if [ -d "$WORKTREE" ]; then
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  fi
  rmdir "$WORKTREE_BASE" >/dev/null 2>&1 || true
}
trap cleanup EXIT
git worktree add --quiet --detach "$WORKTREE" "$TAG"
node "$WORKTREE/scripts/validate-release-schema.mjs" --publish "$VER"
cleanup
trap - EXIT

release_wait_for_github_verified_tag "$REPOSITORY" "$TAG" "$RELEASE_COMMIT"
node "$ROOT/scripts/check-release-publication.mjs" --allow-tag "$TAG"

STATE="$(release_state "$REPOSITORY" "$TAG")"
if [ "$STATE" = "published" ]; then
  printf '✓ %s is already published; no duplicate workflow was dispatched\n' "$TAG"
  exit 0
fi

ACTIVE_RUN="$(release_active_workflow_url "$REPOSITORY" "$TAG")"
if [ -n "$ACTIVE_RUN" ]; then
  printf '✓ Production release is already active for %s; no duplicate was dispatched: %s\n' "$TAG" "$ACTIVE_RUN"
  exit 0
fi

SUCCESSFUL_RUN="$(release_successful_workflow_url "$REPOSITORY" "$TAG")"
if [ "$PUBLISH" = "false" ] && [ "$STATE" = "draft" ] && [ -n "$SUCCESSFUL_RUN" ]; then
  printf '✓ publish=false verification already completed for %s; draft retained: %s\n' "$TAG" "$SUCCESSFUL_RUN"
  exit 0
fi

gh workflow run release.yml \
  --repo "$REPOSITORY" \
  --ref "$TAG" \
  --field "version=$VER" \
  --field "publish=$PUBLISH"

printf '✓ dispatched Production release for %s at %s (publish=%s)\n' "$TAG" "$RELEASE_COMMIT" "$PUBLISH"
printf '  monitor: gh run list --repo %s --workflow release.yml --branch %s\n' "$REPOSITORY" "$TAG"
