#!/usr/bin/env bash
set -euo pipefail

PROXY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZED_REPO="${ZED_REPO:-$(cd "${PROXY_ROOT}/.." && pwd)/zed}"
APP="${APP:-/Applications/Zed Preview Cursor Tab.app}"
UPSTREAM_REMOTE="${ZED_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${ZED_UPSTREAM_URL:-https://github.com/zed-industries/zed.git}"
UPSTREAM_BRANCH="${ZED_UPSTREAM_BRANCH:-main}"
FETCH=1

usage() {
  cat <<'EOF'
Usage: bun run status:zed-macos -- [options]

Check whether the patched Zed checkout and installed app are current.

Options:
  --zed-repo PATH          Path to the patched Zed checkout. Default: ../zed
  --app PATH               Patched app bundle. Default: /Applications/Zed Preview Cursor Tab.app
  --upstream-remote NAME   Upstream remote name. Default: upstream
  --upstream-url URL       Upstream Zed URL. Default: https://github.com/zed-industries/zed.git
  --upstream-branch NAME   Upstream branch. Default: main
  --no-fetch               Do not fetch upstream before checking.
  -h, --help               Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zed-repo)
      ZED_REPO="$2"
      shift 2
      ;;
    --app)
      APP="$2"
      shift 2
      ;;
    --upstream-remote)
      UPSTREAM_REMOTE="$2"
      shift 2
      ;;
    --upstream-url)
      UPSTREAM_URL="$2"
      shift 2
      ;;
    --upstream-branch)
      UPSTREAM_BRANCH="$2"
      shift 2
      ;;
    --no-fetch)
      FETCH=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

failures=0
warn() {
  echo "WARN: $*" >&2
}
fail() {
  echo "FAIL: $*" >&2
  failures=1
}

if [[ ! -d "${ZED_REPO}/.git" ]]; then
  fail "Missing patched Zed git checkout: ${ZED_REPO}"
else
  target_ref=""
  if ! git -C "${ZED_REPO}" remote get-url "${UPSTREAM_REMOTE}" >/dev/null 2>&1; then
    if [[ "${FETCH}" == "1" ]]; then
      git -C "${ZED_REPO}" fetch "${UPSTREAM_URL}" "${UPSTREAM_BRANCH}" --quiet
      target_ref="FETCH_HEAD"
    else
      warn "Missing ${UPSTREAM_REMOTE} remote in ${ZED_REPO}; add ${UPSTREAM_URL}, run update:zed-macos once, or omit --no-fetch."
    fi
  elif [[ "${FETCH}" == "1" ]]; then
    git -C "${ZED_REPO}" fetch "${UPSTREAM_REMOTE}" "${UPSTREAM_BRANCH}" --quiet
    target_ref="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
  elif git -C "${ZED_REPO}" rev-parse --verify "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" >/dev/null 2>&1; then
    target_ref="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
  fi

  zed_head="$(git -C "${ZED_REPO}" rev-parse HEAD)"
  zed_branch="$(git -C "${ZED_REPO}" branch --show-current || true)"
  echo "Zed checkout: ${zed_branch:-detached} ${zed_head}"

  if [[ -n "$(git -C "${ZED_REPO}" status --porcelain)" ]]; then
    fail "Zed checkout has local changes; update:zed-macos will refuse to run."
  fi

  if [[ -n "${target_ref}" ]]; then
    if git -C "${ZED_REPO}" merge-base --is-ancestor "${target_ref}" HEAD; then
      echo "Zed upstream: up to date with ${target_ref}"
    else
      behind_count="$(git -C "${ZED_REPO}" rev-list --count "HEAD..${target_ref}")"
      fail "Zed upstream: ${behind_count} upstream commits available on ${target_ref}; run bun run update:zed-macos"
    fi
  fi
fi

proxy_head="$(git -C "${PROXY_ROOT}" rev-parse HEAD)"
echo "Proxy checkout: ${proxy_head}"

metadata_path="${APP}/Contents/Resources/zed-cursor-tab.json"
if [[ ! -f "${metadata_path}" ]]; then
  fail "Missing installed app metadata: ${metadata_path}; run bun run install:zed-macos -- --no-build"
else
  metadata="$(cat "${metadata_path}")"
  installed_zed="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(m.zed_commit ?? "")' "${metadata_path}")"
  installed_proxy="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(m.proxy_commit ?? "")' "${metadata_path}")"
  installed_at="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(m.installed_at ?? "")' "${metadata_path}")"
  echo "Installed app: ${installed_at}"
  echo "${metadata}"

  if [[ -n "${installed_zed}" && -d "${ZED_REPO}/.git" && "${installed_zed}" != "$(git -C "${ZED_REPO}" rev-parse HEAD)" ]]; then
    fail "Installed Zed commit does not match checkout; run bun run install:zed-macos"
  fi
  if [[ -n "${installed_proxy}" && "${installed_proxy}" != "${proxy_head}" ]]; then
    fail "Installed proxy commit does not match checkout; run bun run install:zed-macos -- --no-build"
  fi
fi

if [[ "${failures}" == "0" ]]; then
  echo "Zed Cursor Tab status: OK"
fi
exit "${failures}"
