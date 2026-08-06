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
  git verify-tag "$tag" >/dev/null 2>&1 \
    || release_fail "$tag signature failed cryptographic verification with 'git verify-tag'; configure local Git signature trust before releasing"

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
      if [ "$verified" = "true" ] \
        && [ "$verification_reason" = "valid" ] \
        && [ "$verified_commit" = "$expected_commit" ]; then
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
  local state

  if ! gh release view "$tag" --repo "$repository" >/dev/null 2>&1; then
    printf 'missing\n'
    return 0
  fi
  state="$(
    gh release view "$tag" \
      --repo "$repository" \
      --json isDraft,isPrerelease \
      --jq 'if .isDraft == true then "draft" elif .isPrerelease == true then "prerelease" elif .isDraft == false and .isPrerelease == false then "published" else "invalid" end'
  )" || release_fail "cannot read the GitHub Release state for $tag"
  case "$state" in
    draft|prerelease|published) printf '%s\n' "$state" ;;
    *) release_fail "GitHub returned an invalid Release state for $tag" ;;
  esac
}

release_workflow_run_records() {
  local repository="$1"
  local tag="$2"
  local expected_commit="$3"
  local publish="$4"
  local kind="$5"
  local request_id="${6:-}"

  gh api \
    "repos/$repository/actions/workflows/release.yml/runs?event=workflow_dispatch&branch=$tag&per_page=100" \
    2>/dev/null \
    | IDACC_EXPECTED_COMMIT="$expected_commit" \
      IDACC_EXPECTED_TAG="$tag" \
      IDACC_EXPECTED_PUBLISH="$publish" \
      IDACC_EXPECTED_RUN_KIND="$kind" \
      IDACC_EXPECTED_REQUEST_ID="$request_id" \
      node -e '
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          const body = JSON.parse(input);
          const prefix = `Production release ${process.env.IDACC_EXPECTED_TAG} publish=${process.env.IDACC_EXPECTED_PUBLISH} request=`;
          const active = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
          const matches = (Array.isArray(body.workflow_runs) ? body.workflow_runs : [])
            .filter((run) => (
              run
              && run.event === "workflow_dispatch"
              && run.head_sha === process.env.IDACC_EXPECTED_COMMIT
              && run.head_branch === process.env.IDACC_EXPECTED_TAG
              && typeof run.display_title === "string"
              && run.display_title.startsWith(prefix)
              && (
                !process.env.IDACC_EXPECTED_REQUEST_ID
                || run.display_title === `${prefix}${process.env.IDACC_EXPECTED_REQUEST_ID}`
              )
              && (
                process.env.IDACC_EXPECTED_RUN_KIND === "active"
                  ? active.has(run.status)
                  : process.env.IDACC_EXPECTED_RUN_KIND === "success"
                    ? run.status === "completed" && run.conclusion === "success"
                    : true
              )
            ))
            .sort((left, right) => Number(right.id) - Number(left.id));
          for (const run of matches) {
            if (!Number.isSafeInteger(run.id) || run.id <= 0 || typeof run.html_url !== "string") {
              process.exit(2);
            }
            process.stdout.write(`${run.id}\t${run.html_url}\n`);
          }
        });
      '
}

release_select_single_workflow_run() {
  local repository="$1"
  local tag="$2"
  local expected_commit="$3"
  local publish="$4"
  local kind="$5"
  local request_id="${6:-}"
  local records
  local count

  records="$(release_workflow_run_records \
    "$repository" "$tag" "$expected_commit" "$publish" "$kind" "$request_id")" \
    || release_fail "cannot inspect exact Production release workflow runs for $tag"
  count="$(printf '%s\n' "$records" | awk 'NF { count += 1 } END { print count + 0 }')"
  if [ "$count" -gt 1 ]; then
    release_fail "multiple matching $kind Production release runs exist for $tag at $expected_commit; refusing to choose by recency"
  fi
  if [ "$count" -eq 1 ]; then
    printf '%s\n' "$records"
  fi
}

release_active_workflow_record() {
  release_select_single_workflow_run "$1" "$2" "$3" "$4" active
}

release_successful_workflow_record() {
  release_select_single_workflow_run "$1" "$2" "$3" "$4" success
}

release_wait_for_dispatched_workflow_record() {
  local repository="$1"
  local tag="$2"
  local expected_commit="$3"
  local publish="$4"
  local request_id="$5"
  local attempt=1
  local record
  local poll_attempts="${IDACC_RELEASE_DISCOVERY_ATTEMPTS:-60}"
  local poll_seconds="${IDACC_RELEASE_DISCOVERY_SECONDS:-2}"

  [[ "$poll_attempts" =~ ^[1-9][0-9]*$ ]] \
    || release_fail "IDACC_RELEASE_DISCOVERY_ATTEMPTS must be a positive integer"
  [[ "$poll_seconds" =~ ^[0-9]+$ ]] \
    || release_fail "IDACC_RELEASE_DISCOVERY_SECONDS must be a non-negative integer"

  while [ "$attempt" -le "$poll_attempts" ]; do
    record="$(release_select_single_workflow_run \
      "$repository" "$tag" "$expected_commit" "$publish" request "$request_id")"
    if [ -n "$record" ]; then
      printf '%s\n' "$record"
      return 0
    fi
    if [ "$attempt" -lt "$poll_attempts" ]; then
      sleep "$poll_seconds"
    fi
    attempt=$((attempt + 1))
  done
  release_fail "GitHub did not expose the uniquely dispatched Production release request $request_id for $tag"
}

release_wait_for_workflow_run() {
  local repository="$1"
  local run_id="$2"
  local tag="$3"
  local expected_commit="$4"
  local publish="$5"
  local request_id="${6:-}"
  local attempt=1
  local poll_attempts="${IDACC_RELEASE_RUN_POLL_ATTEMPTS:-900}"
  local poll_seconds="${IDACC_RELEASE_RUN_POLL_SECONDS:-10}"
  local record
  local observed_id
  local status
  local conclusion
  local head_sha
  local head_branch
  local event
  local display_title
  local html_url
  local expected_prefix="Production release $tag publish=$publish request="

  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || release_fail "workflow run ID must be a positive integer"
  [[ "$poll_attempts" =~ ^[1-9][0-9]*$ ]] \
    || release_fail "IDACC_RELEASE_RUN_POLL_ATTEMPTS must be a positive integer"
  [[ "$poll_seconds" =~ ^[0-9]+$ ]] \
    || release_fail "IDACC_RELEASE_RUN_POLL_SECONDS must be a non-negative integer"

  while [ "$attempt" -le "$poll_attempts" ]; do
    record="$(
      gh api "repos/$repository/actions/runs/$run_id" \
        --jq '[.id, .status, (.conclusion // "none"), .head_sha, .head_branch, .event, .display_title, .html_url] | @tsv' \
        2>/dev/null || true
    )"
    if [ -n "$record" ]; then
      IFS=$'\t' read -r observed_id status conclusion head_sha head_branch event display_title html_url <<< "$record"
      [ "$observed_id" = "$run_id" ] \
        || release_fail "GitHub returned workflow run ${observed_id:-missing}, expected $run_id"
      [ "$head_sha" = "$expected_commit" ] \
        || release_fail "workflow run $run_id head SHA is ${head_sha:-missing}, expected $expected_commit"
      [ "$head_branch" = "$tag" ] \
        || release_fail "workflow run $run_id head branch is ${head_branch:-missing}, expected $tag"
      [ "$event" = "workflow_dispatch" ] \
        || release_fail "workflow run $run_id event is ${event:-missing}, expected workflow_dispatch"
      case "$display_title" in
        "$expected_prefix"*) ;;
        *) release_fail "workflow run $run_id title is not bound to $tag publish=$publish" ;;
      esac
      if [ -n "$request_id" ] && [ "$display_title" != "${expected_prefix}${request_id}" ]; then
        release_fail "workflow run $run_id is not the uniquely dispatched request $request_id"
      fi
      if [ "$status" = "completed" ]; then
        [ "$conclusion" = "success" ] \
          || release_fail "Production release workflow run $run_id completed with ${conclusion:-no conclusion}: $html_url"
        printf '✓ Production release workflow run %s completed successfully for %s at %s: %s\n' \
          "$run_id" "$tag" "$expected_commit" "$html_url"
        return 0
      fi
    fi
    if [ "$attempt" -lt "$poll_attempts" ]; then
      sleep "$poll_seconds"
    fi
    attempt=$((attempt + 1))
  done
  release_fail "Production release workflow run $run_id did not complete within $((poll_attempts * poll_seconds)) seconds"
}
