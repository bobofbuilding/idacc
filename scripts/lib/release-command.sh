#!/usr/bin/env bash

# Shared fail-closed helpers for scripts/release.sh and
# scripts/resume-release.sh. This file is sourced; callers enable
# `set -euo pipefail` before loading it.

release_fail() {
  printf 'release command failed: %s\n' "$*" >&2
  exit 1
}

release_require_gh_auth() {
  command -v gh >/dev/null 2>&1 \
    || release_fail "GitHub CLI is required; install gh and run 'gh auth login --hostname github.com'"
  gh auth status --hostname github.com >/dev/null 2>&1 \
    || release_fail "GitHub CLI is not authenticated; run 'gh auth login --hostname github.com' before releasing"
}

release_github_repository() {
  local repository
  repository="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)"
  [ -n "$repository" ] \
    || release_fail "cannot resolve the GitHub repository from this checkout"
  printf '%s\n' "$repository"
}

release_assert_local_signed_tag() {
  local tag="$1"
  local expected_commit="$2"
  local tag_type
  local tag_body
  local tag_commit

  tag_type="$(git cat-file -t "refs/tags/$tag" 2>/dev/null || true)"
  [ "$tag_type" = "tag" ] \
    || release_fail "$tag must be an annotated tag object; lightweight tags are not releasable"

  tag_body="$(git cat-file -p "refs/tags/$tag" 2>/dev/null || true)"
  printf '%s\n' "$tag_body" \
    | grep -Eq -- '-----BEGIN (PGP|SSH) SIGNATURE-----|-----BEGIN SIGNED MESSAGE-----' \
    || release_fail "$tag is annotated but unsigned; production tags must be created with 'git tag -s -a'"

  tag_commit="$(git rev-list -n 1 "$tag" 2>/dev/null || true)"
  [ "$tag_commit" = "$expected_commit" ] \
    || release_fail "$tag resolves to ${tag_commit:-nothing}, expected application commit $expected_commit"
}

release_assert_remote_tag() {
  local tag="$1"
  local expected_tag_object="$2"
  local expected_commit="$3"
  local remote_tag_object
  local remote_commit

  remote_tag_object="$(git ls-remote --refs origin "refs/tags/$tag" | awk 'NR == 1 { print $1 }')"
  remote_commit="$(git ls-remote origin "refs/tags/$tag^{}" | awk 'NR == 1 { print $1 }')"

  [ "$remote_tag_object" = "$expected_tag_object" ] \
    || release_fail "origin/$tag is ${remote_tag_object:-missing}, expected signed tag object $expected_tag_object"
  [ "$remote_commit" = "$expected_commit" ] \
    || release_fail "origin/$tag resolves to ${remote_commit:-nothing}, expected application commit $expected_commit"
}

release_wait_for_github_verified_tag() {
  local repository="$1"
  local tag="$2"
  local expected_commit="$3"
  local attempt
  local ref_type
  local tag_object
  local verified
  local verified_commit
  local verification_reason

  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    ref_type="$(gh api "repos/$repository/git/ref/tags/$tag" --jq '.object.type' 2>/dev/null || true)"
    tag_object="$(gh api "repos/$repository/git/ref/tags/$tag" --jq '.object.sha' 2>/dev/null || true)"
    if [ "$ref_type" = "tag" ] && [ -n "$tag_object" ]; then
      verified="$(gh api "repos/$repository/git/tags/$tag_object" --jq '.verification.verified' 2>/dev/null || true)"
      verified_commit="$(gh api "repos/$repository/git/tags/$tag_object" --jq '.object.sha' 2>/dev/null || true)"
      verification_reason="$(gh api "repos/$repository/git/tags/$tag_object" --jq '.verification.reason' 2>/dev/null || true)"
      if [ "$verified" = "true" ] && [ "$verified_commit" = "$expected_commit" ]; then
        printf '✓ GitHub verified the signed annotated tag %s at %s\n' "$tag" "$expected_commit"
        return 0
      fi
    fi
    if [ "$attempt" -lt 15 ]; then
      sleep 2
    fi
  done

  release_fail "GitHub did not verify $tag at $expected_commit (type=${ref_type:-missing}, verified=${verified:-false}, reason=${verification_reason:-unknown})"
}

release_state() {
  local repository="$1"
  local tag="$2"
  local is_draft

  if ! gh release view "$tag" --repo "$repository" >/dev/null 2>&1; then
    printf 'missing\n'
    return 0
  fi
  is_draft="$(gh release view "$tag" --repo "$repository" --json isDraft --jq '.isDraft')"
  if [ "$is_draft" = "true" ]; then
    printf 'draft\n'
  else
    printf 'published\n'
  fi
}

release_active_workflow_url() {
  local repository="$1"
  local tag="$2"

  gh api \
    "repos/$repository/actions/workflows/release.yml/runs?event=workflow_dispatch&branch=$tag&per_page=20" \
    --jq '.workflow_runs | map(select(.status == "queued" or .status == "in_progress" or .status == "waiting" or .status == "pending" or .status == "requested")) | .[0].html_url // ""' \
    2>/dev/null || true
}

release_successful_workflow_url() {
  local repository="$1"
  local tag="$2"

  gh api \
    "repos/$repository/actions/workflows/release.yml/runs?event=workflow_dispatch&branch=$tag&status=success&per_page=20" \
    --jq '.workflow_runs[0].html_url // ""' \
    2>/dev/null || true
}
