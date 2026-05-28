#!/usr/bin/env bash
set -euo pipefail

PROXY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZED_REPO="${ZED_REPO:-$(cd "${PROXY_ROOT}/.." && pwd)/zed}"
SOURCE_APP="${SOURCE_APP:-/Applications/Zed Preview.app}"
APP="${APP:-/Applications/Zed Preview Cursor Tab.app}"
BACKUP="${BACKUP:-/Applications/Zed Preview Stock.app}"
PORT="${ZED_CURSOR_PROXY_PORT:-17878}"

usage() {
  cat <<'EOF'
Usage: bun run install:zed-macos -- [options]

Options:
  --zed-repo PATH       Path to the patched Zed checkout. Default: ../zed
  --source-app PATH     Existing Zed Preview.app to copy icon/bundle metadata from.
  --app PATH            Destination app bundle. Default: /Applications/Zed Preview Cursor Tab.app
  --backup PATH         Backup path for stock Zed Preview.app.
  --no-build            Skip cargo build and install already-built release binaries.
  -h, --help            Show this help.

Environment:
  ZED_REPO, SOURCE_APP, APP, BACKUP, ZED_CURSOR_PROXY_PORT, CARGO_INCREMENTAL
EOF
}

BUILD=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --zed-repo)
      ZED_REPO="$2"
      shift 2
      ;;
    --source-app)
      SOURCE_APP="$2"
      shift 2
      ;;
    --app)
      APP="$2"
      shift 2
      ;;
    --backup)
      BACKUP="$2"
      shift 2
      ;;
    --no-build)
      BUILD=0
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

if [[ ! -d "${ZED_REPO}" ]]; then
  echo "Missing patched Zed checkout: ${ZED_REPO}" >&2
  echo "Clone https://github.com/nicolasdeory/zed and check out cursor-tab-external-provider." >&2
  exit 1
fi

CARGO="${CARGO:-$(command -v cargo || true)}"
BUN="${BUN:-$(command -v bun || true)}"
if [[ -z "${CARGO}" || ! -x "${CARGO}" ]]; then
  echo "Cannot find cargo. Install Rust first." >&2
  exit 1
fi
if [[ -z "${BUN}" || ! -x "${BUN}" ]]; then
  echo "Cannot find bun. Install Bun first." >&2
  exit 1
fi

if [[ "${BUILD}" == "1" ]]; then
  INCREMENTAL="${CARGO_INCREMENTAL:-1}"
  if [[ "${INCREMENTAL}" != "0" ]] && ! xcrun -sdk macosx metal -v >/dev/null 2>&1; then
    echo "Metal Toolchain is unavailable for Xcode's macOS SDK; using non-incremental release build."
    echo "For faster future builds, run: xcodebuild -downloadComponent MetalToolchain"
    INCREMENTAL=0
  fi

  (
    cd "${ZED_REPO}"
    CXXFLAGS="${CXXFLAGS:--stdlib=libc++}" \
      ZED_RELEASE_CHANNEL=preview \
      CARGO_INCREMENTAL="${INCREMENTAL}" \
      CARGO_PROFILE_RELEASE_DEBUG="${CARGO_PROFILE_RELEASE_DEBUG:-0}" \
      "${CARGO}" build --release --package zed --package cli
  )
fi

RELEASE_ZED="${ZED_REPO}/target/release/zed"
RELEASE_CLI="${ZED_REPO}/target/release/cli"
if [[ ! -x "${RELEASE_ZED}" || ! -x "${RELEASE_CLI}" ]]; then
  echo "Missing release binaries in ${ZED_REPO}/target/release." >&2
  echo "Run without --no-build, or build: cargo build --release --package zed --package cli" >&2
  exit 1
fi

if [[ ! -d "${SOURCE_APP}" && ! -d "${APP}" && ! -d "${BACKUP}" ]]; then
  echo "Missing source app: ${SOURCE_APP}" >&2
  echo "Install Zed Preview first, or pass --source-app /path/to/Zed.app." >&2
  exit 1
fi

if [[ ! -d "${BACKUP}" && -d "${SOURCE_APP}" ]]; then
  echo "Backing up stock Zed Preview app to ${BACKUP}"
  cp -R "${SOURCE_APP}" "${BACKUP}"
fi

if [[ ! -d "${APP}" ]]; then
  echo "Creating patched app bundle at ${APP}"
  cp -R "${BACKUP}" "${APP}"
fi

MACOS="${APP}/Contents/MacOS"
WRAPPER="${MACOS}/zed"
REAL_ZED="${MACOS}/zed-bin"

echo "Installing release Zed binary into ${APP}"
cp "${RELEASE_ZED}" "${REAL_ZED}"
cp "${RELEASE_CLI}" "${MACOS}/cli"

cat >"${WRAPPER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

PROXY_ROOT="${PROXY_ROOT}"
PORT="\${ZED_CURSOR_PROXY_PORT:-${PORT}}"
HEALTH_URL="http://127.0.0.1:\${PORT}/health"
LOG_DIR="\${HOME}/Library/Logs/ZedCursorTab"
LOG_FILE="\${LOG_DIR}/proxy.log"
BUN="${BUN}"

mkdir -p "\${LOG_DIR}"

if ! /usr/bin/curl -fsS "\${HEALTH_URL}" >/dev/null 2>&1; then
  if [[ ! -x "\${BUN}" ]]; then
    BUN="\$(command -v bun || true)"
  fi

  if [[ -z "\${BUN}" || ! -x "\${BUN}" ]]; then
    echo "Cannot find bun to start Cursor Tab proxy." >>"\${LOG_FILE}"
  else
    (
      cd "\${PROXY_ROOT}"
      exec "\${BUN}" run zed-proxy
    ) >>"\${LOG_FILE}" 2>&1 &

    for _ in {1..50}; do
      if /usr/bin/curl -fsS "\${HEALTH_URL}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
  fi
fi

if ! /usr/bin/curl -fsS "\${HEALTH_URL}" >/dev/null 2>&1; then
  echo "Cursor Tab proxy is not healthy; launching Zed anyway." >>"\${LOG_FILE}"
fi

exec "\$(dirname "\${BASH_SOURCE[0]}")/zed-bin" "\$@"
EOF

chmod +x "${WRAPPER}" "${REAL_ZED}" "${MACOS}/cli"

if /usr/bin/codesign --force --deep --sign - "${APP}" >/dev/null 2>&1; then
  echo "Ad-hoc signed ${APP}"
else
  echo "Warning: codesign failed; macOS may ask before launching the patched app." >&2
fi

echo "Installed patched Zed Preview at ${APP}"
