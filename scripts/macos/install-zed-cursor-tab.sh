#!/usr/bin/env bash
set -euo pipefail

PROXY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ZED_REPO="${ZED_REPO:-$(cd "${PROXY_ROOT}/.." && pwd)/zed}"
SOURCE_APP="${SOURCE_APP:-/Applications/Zed Preview.app}"
APP="${APP:-/Applications/Zed Preview Cursor Tab.app}"
BACKUP="${BACKUP:-/Applications/Zed Preview Stock.app}"
PORT="${ZED_CURSOR_PROXY_PORT:-17878}"
SETTINGS_PATH="${ZED_SETTINGS_PATH:-${HOME}/.config/zed/settings.json}"
APPTIVATE_HOTKEYS="${APPTIVATE_HOTKEYS:-${HOME}/Library/Application Support/Apptivate/hotkeys}"
CONFIGURE_SETTINGS=1
CONFIGURE_DOCK=1
CONFIGURE_APPTIVATE=1
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
  --apptivate-hotkeys PATH
                        Apptivate hotkeys plist. Default: ~/Library/Application Support/Apptivate/hotkeys
  --no-settings         Do not update Zed settings.
  --no-dock             Do not add the patched app to the Dock.
  --no-apptivate        Do not retarget Apptivate Ctrl-2 to the patched app.
  --no-build            Skip cargo build and install already-built release binaries.
  --clean-build-cache   Remove regenerable Zed debug/incremental build artifacts before building.
  --min-free-gb GB      Minimum free disk space required before building. Default: 25.
  -h, --help            Show this help.

Environment:
  ZED_REPO, SOURCE_APP, APP, BACKUP, ZED_SETTINGS_PATH, ZED_CURSOR_PROXY_PORT,
  ZED_CURSOR_MIN_FREE_GB, APPTIVATE_HOTKEYS, CARGO_INCREMENTAL
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
    --apptivate-hotkeys)
      APPTIVATE_HOTKEYS="$2"
      shift 2
      ;;
    --no-settings)
      CONFIGURE_SETTINGS=0
      shift
      ;;
    --no-dock)
      CONFIGURE_DOCK=0
      shift
      ;;
    --no-apptivate)
      CONFIGURE_APPTIVATE=0
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

configure_dock() {
  local app_url app_label

  app_url="$(APP="${APP}" "${BUN}" --eval '
const { pathToFileURL } = require("node:url");
let url = pathToFileURL(process.env.APP).href;
if (!url.endsWith("/")) url += "/";
process.stdout.write(url);
')"
  app_label="$(basename "${APP}" .app)"

  if /usr/bin/defaults read com.apple.dock persistent-apps 2>/dev/null | /usr/bin/grep -Fq "${app_url}"; then
    echo "${app_label} is already in the Dock."
    return 0
  fi

  echo "Adding ${app_label} to the Dock."
  /usr/bin/defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>${app_url}</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>${app_label}</string><key>file-type</key><integer>41</integer></dict><key>tile-type</key><string>file-tile</string></dict>"
  /usr/bin/killall Dock >/dev/null 2>&1 || true
}

configure_apptivate_hotkey() (
  set -euo pipefail

  local tmp_dir backup python
  if [[ ! -f "${APPTIVATE_HOTKEYS}" ]]; then
    echo "Apptivate hotkeys file not found; skipping Ctrl-2 setup."
    return 0
  fi
  if [[ ! -x "/usr/bin/clang" ]]; then
    echo "clang not found; skipping Apptivate Ctrl-2 setup."
    return 0
  fi
  python="$(command -v python3 || true)"
  if [[ -z "${python}" ]]; then
    echo "python3 not found; skipping Apptivate Ctrl-2 setup."
    return 0
  fi

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' EXIT

  cat >"${tmp_dir}/make_alias.c" <<'EOF'
#include <CoreServices/CoreServices.h>
#include <stdio.h>

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: make_alias PATH\n");
    return 2;
  }

  FSRef ref;
  Boolean is_directory = false;
  OSStatus err = FSPathMakeRef((const UInt8 *)argv[1], &ref, &is_directory);
  if (err != noErr) {
    fprintf(stderr, "FSPathMakeRef failed: %d\n", (int)err);
    return 1;
  }

  AliasHandle alias = NULL;
  err = FSNewAlias(NULL, &ref, &alias);
  if (err != noErr || alias == NULL) {
    fprintf(stderr, "FSNewAlias failed: %d\n", (int)err);
    return 1;
  }

  Size size = GetHandleSize((Handle)alias);
  HLock((Handle)alias);
  fwrite(*alias, 1, size, stdout);
  HUnlock((Handle)alias);
  DisposeHandle((Handle)alias);
  return 0;
}
EOF

  /usr/bin/clang -Wno-deprecated-declarations -framework CoreServices "${tmp_dir}/make_alias.c" -o "${tmp_dir}/make_alias"
  "${tmp_dir}/make_alias" "${APP}" >"${tmp_dir}/target.alias"

  backup="${APPTIVATE_HOTKEYS}.backup.$(date +%Y%m%d%H%M%S)"
  cp "${APPTIVATE_HOTKEYS}" "${backup}"

  "${python}" - "${APPTIVATE_HOTKEYS}" "${tmp_dir}/target.alias" <<'PY'
import plistlib
import sys
from pathlib import Path

hotkeys_path = Path(sys.argv[1])
alias_data = Path(sys.argv[2]).read_bytes()

with hotkeys_path.open("rb") as f:
    plist = plistlib.load(f)

objects = plist["$objects"]

def uid_value(value):
    if isinstance(value, plistlib.UID):
        return value.data
    raise TypeError(f"expected UID, got {type(value)!r}")

alias_data_index = None
item_index = None

for index, item in enumerate(objects):
    if not isinstance(item, dict):
        continue
    if "fileAlias" not in item or "hotkeys" not in item:
        continue

    hotkeys_array = objects[uid_value(item["hotkeys"])]
    for hotkey_uid in hotkeys_array.get("NS.objects", []):
        hotkey = objects[uid_value(hotkey_uid)]
        combo = objects[uid_value(hotkey["keyCombo"])]
        if combo.get("keyCode") == 19 and combo.get("mods") == 4352:
            alias = objects[uid_value(item["fileAlias"])]
            alias_data_index = uid_value(alias["$0"])
            item_index = index
            break
    if alias_data_index is not None:
        break

if alias_data_index is None:
    raise SystemExit("Could not find Apptivate Ctrl-2 entry")

objects[alias_data_index] = alias_data

with hotkeys_path.open("wb") as f:
    plistlib.dump(plist, f, fmt=plistlib.FMT_BINARY, sort_keys=False)

print(f"Updated Apptivate item {item_index} alias data object {alias_data_index}")
PY

  echo "Backed up previous Apptivate hotkeys to ${backup}"
  echo "Updated Apptivate Ctrl-2 to ${APP}"
)

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

resolve_metal_toolchain_bin_dir() {
  local metal_bin

  metal_bin="$(find /var/run/com.apple.security.cryptexd/mnt \
    -path '*/Metal.xctoolchain/usr/bin/metal' \
    -type f \
    -perm +111 \
    -print \
    2>/dev/null | head -n 1 || true)"

  if [[ -n "${metal_bin}" && -x "${metal_bin}" ]]; then
    local metal_bin_dir
    metal_bin_dir="$(dirname "${metal_bin}")"
    if "${metal_bin_dir}/metal" -v >/dev/null 2>&1 && "${metal_bin_dir}/metallib" -v >/dev/null 2>&1; then
      echo "${metal_bin_dir}"
      return 0
    fi
  fi

  return 1
}

xcrun_metal_tools_available() {
  if xcrun -sdk macosx metal -v >/dev/null 2>&1 && xcrun -sdk macosx metallib -v >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

install_xcrun_metal_wrapper() {
  local metal_bin_dir="$1"
  local wrapper_dir

  wrapper_dir="$(mktemp -d "${TMPDIR:-/tmp}/zed-metal-xcrun.XXXXXX")"
  cat >"${wrapper_dir}/xcrun" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "-sdk" && "\${2:-}" == "macosx" && ( "\${3:-}" == "metal" || "\${3:-}" == "metallib" ) ]]; then
  tool="\${3}"
  shift 3
  exec "${metal_bin_dir}/\${tool}" "\$@"
fi

exec /usr/bin/xcrun "\$@"
EOF
  chmod +x "${wrapper_dir}/xcrun"
  echo "${wrapper_dir}"
}

if [[ "${BUILD}" == "1" ]]; then
  preflight_build_disk

  INCREMENTAL="${CARGO_INCREMENTAL:-1}"
  METAL_XCRUN_WRAPPER_DIR=""
  if ! xcrun_metal_tools_available; then
    echo "Metal Toolchain was not resolved by xcrun; clearing xcrun cache and retrying."
    xcrun -k >/dev/null 2>&1 || true
    if ! xcrun_metal_tools_available; then
      METAL_BIN_DIR="$(resolve_metal_toolchain_bin_dir || true)"
      if [[ -n "${METAL_BIN_DIR}" ]]; then
        METAL_XCRUN_WRAPPER_DIR="$(install_xcrun_metal_wrapper "${METAL_BIN_DIR}")"
        echo "Using direct Metal Toolchain at ${METAL_BIN_DIR} for this build."
      else
        echo "Metal Toolchain is unavailable for Xcode's macOS SDK."
        echo "For faster future builds, run: xcodebuild -downloadComponent MetalToolchain"
        if [[ "${INCREMENTAL}" != "0" ]]; then
          echo "Using non-incremental release build."
          INCREMENTAL=0
        fi
      fi
    fi
  fi

  (
    cd "${ZED_REPO}"
    if [[ -n "${METAL_XCRUN_WRAPPER_DIR}" ]]; then
      export PATH="${METAL_XCRUN_WRAPPER_DIR}:${PATH}"
    fi
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
    <string>scripts/zedExternalProxy.ts</string>
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
        exec "\${BUN}" run scripts/zedExternalProxy.ts
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
    <string>scripts/zedExternalProxy.ts</string>
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

if [[ "${CONFIGURE_DOCK}" == "1" ]]; then
  if ! configure_dock; then
    echo "Warning: could not add ${APP} to the Dock." >&2
  fi
fi

if [[ "${CONFIGURE_APPTIVATE}" == "1" ]]; then
  if ! configure_apptivate_hotkey; then
    echo "Warning: could not update Apptivate Ctrl-2 for ${APP}." >&2
  fi
fi

if [[ "${CONFIGURE_SETTINGS}" == "1" ]]; then
  configure_zed_settings
fi

echo "Installed patched Zed Preview at ${APP}"
