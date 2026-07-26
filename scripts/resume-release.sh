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

release_wait_for_github_verified_tag "$REPOSITORY" "$TAG" "$RELEASE_COMMIT"
node "$ROOT/scripts/check-release-publication.mjs" --allow-tag "$TAG"

STATE="$(release_state "$REPOSITORY" "$TAG")"
if [ "$STATE" = "prerelease" ]; then
  release_fail "$TAG is a prerelease; prereleases cannot satisfy or resume the stable production release path"
fi
if [ "$STATE" = "published" ]; then
  (
    unset GH_TOKEN GITHUB_TOKEN IDACC_RELEASE_TOKEN RELEASE_ADMIN_TOKEN
    node "$WORKTREE/scripts/verify-public-release.mjs" \
      --repo "$REPOSITORY" \
      --tag "$TAG" \
      --commit "$RELEASE_COMMIT"
  )
  cleanup
  trap - EXIT
  printf '✓ %s is already published and its public release/update path is verified; no duplicate workflow was dispatched\n' "$TAG"
  exit 0
fi

ACTIVE_RUN="$(release_active_workflow_record "$REPOSITORY" "$TAG" "$RELEASE_COMMIT" "$PUBLISH")"
if [ -n "$ACTIVE_RUN" ]; then
  IFS=$'\t' read -r RUN_ID RUN_URL <<< "$ACTIVE_RUN"
  printf '▶ waiting for already-active exact Production release run %s: %s\n' "$RUN_ID" "$RUN_URL"
  release_wait_for_workflow_run \
    "$REPOSITORY" "$RUN_ID" "$TAG" "$RELEASE_COMMIT" "$PUBLISH"
  if [ "$PUBLISH" = "true" ]; then
    (
      unset GH_TOKEN GITHUB_TOKEN IDACC_RELEASE_TOKEN RELEASE_ADMIN_TOKEN
      node "$WORKTREE/scripts/verify-public-release.mjs" \
        --repo "$REPOSITORY" \
        --tag "$TAG" \
        --commit "$RELEASE_COMMIT"
    )
  else
    [ "$(release_state "$REPOSITORY" "$TAG")" = "draft" ] \
      || release_fail "publish=false run $RUN_ID did not retain the expected draft release"
  fi
  cleanup
  trap - EXIT
  printf '✓ Production release run %s and its requested completion state are verified\n' "$RUN_ID"
  exit 0
fi

SUCCESSFUL_RUN="$(release_successful_workflow_record "$REPOSITORY" "$TAG" "$RELEASE_COMMIT" "$PUBLISH")"
if [ "$PUBLISH" = "false" ] && [ "$STATE" = "draft" ] && [ -n "$SUCCESSFUL_RUN" ]; then
  IFS=$'\t' read -r RUN_ID RUN_URL <<< "$SUCCESSFUL_RUN"
  release_wait_for_workflow_run \
    "$REPOSITORY" "$RUN_ID" "$TAG" "$RELEASE_COMMIT" "$PUBLISH"
  cleanup
  trap - EXIT
  printf '✓ publish=false verification already completed for %s; exact run %s retained the draft: %s\n' \
    "$TAG" "$RUN_ID" "$RUN_URL"
  exit 0
fi

REQUEST_ID="idacc-$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
gh workflow run release.yml \
  --repo "$REPOSITORY" \
  --ref "$TAG" \
  --field "version=$VER" \
  --field "publish=$PUBLISH" \
  --field "request_id=$REQUEST_ID"

RUN_RECORD="$(release_wait_for_dispatched_workflow_record \
  "$REPOSITORY" "$TAG" "$RELEASE_COMMIT" "$PUBLISH" "$REQUEST_ID")"
IFS=$'\t' read -r RUN_ID RUN_URL <<< "$RUN_RECORD"
printf '▶ dispatched exact Production release request %s as run %s: %s\n' \
  "$REQUEST_ID" "$RUN_ID" "$RUN_URL"
release_wait_for_workflow_run \
  "$REPOSITORY" "$RUN_ID" "$TAG" "$RELEASE_COMMIT" "$PUBLISH" "$REQUEST_ID"

if [ "$PUBLISH" = "true" ]; then
  (
    unset GH_TOKEN GITHUB_TOKEN IDACC_RELEASE_TOKEN RELEASE_ADMIN_TOKEN
    node "$WORKTREE/scripts/verify-public-release.mjs" \
      --repo "$REPOSITORY" \
      --tag "$TAG" \
      --commit "$RELEASE_COMMIT"
  )
else
  [ "$(release_state "$REPOSITORY" "$TAG")" = "draft" ] \
    || release_fail "publish=false run $RUN_ID did not retain the expected draft release"
fi

cleanup
trap - EXIT
printf '✓ completed and independently verified Production release run %s for %s at %s (publish=%s)\n' \
  "$RUN_ID" "$TAG" "$RELEASE_COMMIT" "$PUBLISH"
