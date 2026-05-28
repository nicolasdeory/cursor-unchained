#!/usr/bin/env bash
set -euo pipefail

PROXY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZED_REPO="${ZED_REPO:-$(cd "${PROXY_ROOT}/.." && pwd)/zed}"
UPSTREAM_REMOTE="${ZED_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${ZED_UPSTREAM_URL:-https://github.com/zed-industries/zed.git}"
UPSTREAM_BRANCH="${ZED_UPSTREAM_BRANCH:-main}"
INSTALL=1
FORCE_INSTALL=0
DRY_RUN=0
INSTALL_ARGS=()

usage() {
  cat <<'EOF'
Usage: bun run update:zed-macos -- [options]

Safely update the patched Zed checkout from upstream Zed and reinstall the
macOS app when the update succeeds.

Options:
  --zed-repo PATH          Path to the patched Zed checkout. Default: ../zed
  --upstream-remote NAME   Upstream remote name. Default: upstream
  --upstream-url URL       Upstream Zed URL. Default: https://github.com/zed-industries/zed.git
  --upstream-branch NAME   Upstream branch. Default: main
  --no-install             Rebase only; do not reinstall the app.
  --force-install          Reinstall even if the branch was already up to date.
  --install-arg ARG        Pass an extra argument to install:zed-macos. Repeatable.
  --dry-run                Show what would happen without changing remotes, branch, or app.
  -h, --help               Show this help.

Environment:
  ZED_REPO, ZED_UPSTREAM_REMOTE, ZED_UPSTREAM_URL, ZED_UPSTREAM_BRANCH
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zed-repo)
      ZED_REPO="$2"
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
    --no-install)
      INSTALL=0
      shift
      ;;
    --force-install)
      FORCE_INSTALL=1
      shift
      ;;
    --install-arg)
      INSTALL_ARGS+=("$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
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

if [[ ! -d "${ZED_REPO}/.git" ]]; then
  echo "Missing patched Zed git checkout: ${ZED_REPO}" >&2
  exit 1
fi

cd "${ZED_REPO}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Zed checkout has local changes; refusing to update until it is clean." >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ -z "${current_branch}" ]]; then
  echo "Zed checkout is detached; refusing to rebase automatically." >&2
  exit 1
fi

if ! git remote get-url "${UPSTREAM_REMOTE}" >/dev/null 2>&1; then
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "Would add remote ${UPSTREAM_REMOTE}: ${UPSTREAM_URL}"
  else
    echo "Adding remote ${UPSTREAM_REMOTE}: ${UPSTREAM_URL}"
    git remote add "${UPSTREAM_REMOTE}" "${UPSTREAM_URL}"
  fi
fi

echo "Checking ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} for Zed updates..."
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "Would run: git fetch ${UPSTREAM_REMOTE} ${UPSTREAM_BRANCH}"
  echo "Would rebase ${current_branch} onto ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} if needed."
  if [[ "${INSTALL}" == "1" ]]; then
    echo "Would reinstall patched app with install:zed-macos after a successful update."
  fi
  exit 0
fi

git fetch "${UPSTREAM_REMOTE}" "${UPSTREAM_BRANCH}"
target="${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"
updated=0

if git merge-base --is-ancestor "${target}" HEAD; then
  echo "Patched Zed is already up to date with ${target}."
else
  echo "Rebasing ${current_branch} on ${target}..."
  if git rebase "${target}"; then
    echo "Updated patched Zed successfully."
    updated=1
  else
    echo "Zed update conflicted; aborting rebase and leaving the current build alone." >&2
    git rebase --abort >/dev/null 2>&1 || true
    exit 1
  fi
fi

if [[ "${INSTALL}" == "1" && ( "${updated}" == "1" || "${FORCE_INSTALL}" == "1" ) ]]; then
  cd "${PROXY_ROOT}"
  exec bash scripts/macos/install-zed-cursor-tab.sh --zed-repo "${ZED_REPO}" "${INSTALL_ARGS[@]}"
fi

if [[ "${INSTALL}" == "1" ]]; then
  echo "Skipped reinstall because no upstream update was applied. Use --force-install to reinstall anyway."
fi
