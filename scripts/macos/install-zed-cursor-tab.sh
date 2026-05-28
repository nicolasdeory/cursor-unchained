#!/usr/bin/env bash
set -euo pipefail

PROXY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZED_REPO="${ZED_REPO:-$(cd "${PROXY_ROOT}/.." && pwd)/zed}"
SOURCE_APP="${SOURCE_APP:-/Applications/Zed Preview.app}"
APP="${APP:-/Applications/Zed Preview Cursor Tab.app}"
BACKUP="${BACKUP:-/Applications/Zed Preview Stock.app}"
PORT="${ZED_CURSOR_PROXY_PORT:-17878}"
SETTINGS_PATH="${ZED_SETTINGS_PATH:-${HOME}/.config/zed/settings.json}"
CONFIGURE_SETTINGS=1
MIN_FREE_GB="${ZED_CURSOR_MIN_FREE_GB:-25}"
CLEAN_BUILD_CACHE=0

usage() {
  cat <<'EOF'
Usage: bun run install:zed-macos -- [options]

Options:
  --zed-repo PATH       Path to the patched Zed checkout. Default: ../zed
  --source-app PATH     Existing Zed Preview.app to copy icon/bundle metadata from.
  --app PATH            Destination app bundle. Default: /Applications/Zed Preview Cursor Tab.app
  --backup PATH         Backup path for stock Zed Preview.app.
  --settings-path PATH  Zed settings file to update. Default: ~/.config/zed/settings.json
  --no-settings         Do not update Zed settings.
  --no-build            Skip cargo build and install already-built release binaries.
  --clean-build-cache   Remove regenerable Zed debug/incremental build artifacts before building.
  --min-free-gb GB      Minimum free disk space required before building. Default: 25.
  -h, --help            Show this help.

Environment:
  ZED_REPO, SOURCE_APP, APP, BACKUP, ZED_SETTINGS_PATH, ZED_CURSOR_PROXY_PORT,
  ZED_CURSOR_MIN_FREE_GB, CARGO_INCREMENTAL
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
    --settings-path)
      SETTINGS_PATH="$2"
      shift 2
      ;;
    --no-settings)
      CONFIGURE_SETTINGS=0
      shift
      ;;
    --no-build)
      BUILD=0
      shift
      ;;
    --clean-build-cache)
      CLEAN_BUILD_CACHE=1
      shift
      ;;
    --min-free-gb)
      MIN_FREE_GB="$2"
      shift 2
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

configure_zed_settings() {
  local predict_url settings_dir backup_path
  predict_url="http://127.0.0.1:${PORT}/predict"
  settings_dir="$(dirname "${SETTINGS_PATH}")"

  mkdir -p "${settings_dir}"
  if [[ -f "${SETTINGS_PATH}" ]]; then
    backup_path="${SETTINGS_PATH}.backup.$(date +%Y%m%d%H%M%S)"
    cp "${SETTINGS_PATH}" "${backup_path}"
    echo "Backed up Zed settings to ${backup_path}"
  fi

  SETTINGS_PATH="${SETTINGS_PATH}" PREDICT_URL="${predict_url}" "${BUN}" --eval '
const fs = require("node:fs");
const path = process.env.SETTINGS_PATH;
const predictUrl = process.env.PREDICT_URL;

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        index++;
      }
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        index++;
      }
      index++;
      continue;
    }
    output += char;
  }
  return output;
}

function parseSettings(source) {
  const trimmed = source.trim();
  if (!trimmed) {
    return {};
  }
  const json = stripJsonComments(trimmed).replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(json);
}

let settings = {};
if (fs.existsSync(path)) {
  settings = parseSettings(fs.readFileSync(path, "utf8"));
}

settings.edit_predictions ??= {};
settings.edit_predictions.provider = "external";
settings.edit_predictions.external ??= {};
settings.edit_predictions.external.api_url = predictUrl;

fs.writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
'
  echo "Configured Zed edit predictions to use ${predict_url}"
}

free_disk_gb() {
  local path free_kb
  path="$1"
  free_kb="$(df -Pk "${path}" | awk 'NR == 2 { print $4 }')"
  echo $((free_kb / 1024 / 1024))
}

preflight_build_disk() {
  local free_gb

  if [[ "${CLEAN_BUILD_CACHE}" == "1" ]]; then
    echo "Removing regenerable Zed debug and incremental build artifacts."
    rm -rf "${ZED_REPO}/target/debug" "${ZED_REPO}/target/release/incremental"
  fi

  free_gb="$(free_disk_gb "${ZED_REPO}")"
  if (( free_gb < MIN_FREE_GB )); then
    cat >&2 <<EOF
Only ${free_gb}G free near ${ZED_REPO}; release builds need about ${MIN_FREE_GB}G.

Try:
  bun run install:zed-macos -- --clean-build-cache

Or when updating:
  bun run update:zed-macos -- --install-arg --clean-build-cache

You can lower the threshold with --min-free-gb if you know the build will fit.
EOF
    exit 1
  fi
}

if [[ "${BUILD}" == "1" ]]; then
  preflight_build_disk

  INCREMENTAL="${CARGO_INCREMENTAL:-1}"
  if [[ "${INCREMENTAL}" != "0" ]] && ! xcrun -sdk macosx metal -v >/dev/null 2>&1; then
    echo "Metal Toolchain was not resolved by xcrun; clearing xcrun cache and retrying."
    xcrun -k >/dev/null 2>&1 || true
    if ! xcrun -sdk macosx metal -v >/dev/null 2>&1; then
      echo "Metal Toolchain is unavailable for Xcode's macOS SDK; using non-incremental release build."
      echo "For faster future builds, run: xcodebuild -downloadComponent MetalToolchain && xcrun -k"
      INCREMENTAL=0
    fi
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
RESOURCES="${APP}/Contents/Resources"
WRAPPER="${MACOS}/zed"
REAL_ZED="${MACOS}/zed-bin"
METADATA="${RESOURCES}/zed-cursor-tab.json"

echo "Installing release Zed binary into ${APP}"
cp "${RELEASE_ZED}" "${REAL_ZED}"
cp "${RELEASE_CLI}" "${MACOS}/cli"
mkdir -p "${RESOURCES}"

cat >"${WRAPPER}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

PROXY_ROOT="${PROXY_ROOT}"
PORT="\${ZED_CURSOR_PROXY_PORT:-${PORT}}"
HEALTH_URL="http://127.0.0.1:\${PORT}/health"
LOG_DIR="\${HOME}/Library/Logs/ZedCursorTab"
LOG_FILE="\${LOG_DIR}/proxy.log"
PLIST="\${HOME}/Library/LaunchAgents/zed-cursor-tab-proxy.plist"
LAUNCHD_TARGET="gui/\$(/usr/bin/id -u)"
BUN="${BUN}"

mkdir -p "\${LOG_DIR}"

if ! /usr/bin/curl -fsS "\${HEALTH_URL}" >/dev/null 2>&1; then
  if [[ ! -x "\${BUN}" ]]; then
    BUN="\$(command -v bun || true)"
  fi

  if [[ -z "\${BUN}" || ! -x "\${BUN}" ]]; then
    echo "Cannot find bun to start Cursor Tab proxy." >>"\${LOG_FILE}"
  else
    mkdir -p "\${HOME}/Library/LaunchAgents"
    cat >"\${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>zed-cursor-tab-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>\${BUN}</string>
    <string>run</string>
    <string>zed-proxy</string>
  </array>
  <key>WorkingDirectory</key>
  <string>\${PROXY_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>\${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>\${LOG_FILE}</string>
</dict>
</plist>
PLIST

    /bin/launchctl remove zed-cursor-tab-proxy >/dev/null 2>&1 || true
    /bin/launchctl bootout "\${LAUNCHD_TARGET}" "\${PLIST}" >/dev/null 2>&1 || true
    if ! /bin/launchctl bootstrap "\${LAUNCHD_TARGET}" "\${PLIST}" >/dev/null 2>&1; then
      /bin/launchctl kickstart -k "\${LAUNCHD_TARGET}/zed-cursor-tab-proxy" >/dev/null 2>&1 || true
    fi

    if ! /bin/launchctl kickstart -k "\${LAUNCHD_TARGET}/zed-cursor-tab-proxy" >/dev/null 2>&1; then
      (
        cd "\${PROXY_ROOT}"
        exec "\${BUN}" run zed-proxy
      ) >>"\${LOG_FILE}" 2>&1 &
    fi

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

ZED_COMMIT="$(git -C "${ZED_REPO}" rev-parse HEAD 2>/dev/null || true)"
PROXY_COMMIT="$(git -C "${PROXY_ROOT}" rev-parse HEAD 2>/dev/null || true)"
INSTALLED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
METADATA="${METADATA}" ZED_COMMIT="${ZED_COMMIT}" PROXY_COMMIT="${PROXY_COMMIT}" INSTALLED_AT="${INSTALLED_AT}" PORT="${PORT}" "${BUN}" --eval '
const fs = require("node:fs");
const metadata = {
  schema: 1,
  installed_at: process.env.INSTALLED_AT,
  zed_commit: process.env.ZED_COMMIT || null,
  proxy_commit: process.env.PROXY_COMMIT || null,
  proxy_port: Number(process.env.PORT),
};
fs.writeFileSync(process.env.METADATA, `${JSON.stringify(metadata, null, 2)}\n`);
'

LOG_DIR="${HOME}/Library/Logs/ZedCursorTab"
LOG_FILE="${LOG_DIR}/proxy.log"
PLIST="${HOME}/Library/LaunchAgents/zed-cursor-tab-proxy.plist"
LAUNCHD_TARGET="gui/$(/usr/bin/id -u)"

mkdir -p "${LOG_DIR}" "${HOME}/Library/LaunchAgents"
cat >"${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>zed-cursor-tab-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${BUN}</string>
    <string>run</string>
    <string>zed-proxy</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROXY_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
PLIST

/bin/launchctl remove zed-cursor-tab-proxy >/dev/null 2>&1 || true
/bin/launchctl bootout "${LAUNCHD_TARGET}" "${PLIST}" >/dev/null 2>&1 || true
if /bin/launchctl bootstrap "${LAUNCHD_TARGET}" "${PLIST}" >/dev/null 2>&1; then
  /bin/launchctl kickstart -k "${LAUNCHD_TARGET}/zed-cursor-tab-proxy" >/dev/null 2>&1 || true
  echo "Started Cursor Tab proxy LaunchAgent."
else
  echo "Warning: could not bootstrap Cursor Tab proxy LaunchAgent; the app wrapper will retry on launch."
fi

if /usr/bin/codesign --force --deep --sign - "${APP}" >/dev/null 2>&1; then
  echo "Ad-hoc signed ${APP}"
else
  echo "Warning: codesign failed; macOS may ask before launching the patched app." >&2
fi

if [[ "${CONFIGURE_SETTINGS}" == "1" ]]; then
  configure_zed_settings
fi

echo "Installed patched Zed Preview at ${APP}"
