import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type CommandResult = {
  name: string;
  status: number;
  stdout: string;
  stderr: string;
};

type CommandOptions = {
  quiet?: boolean;
  env?: Record<string, string>;
};

const proxyUrl = process.env.ZED_CURSOR_PROXY_URL ?? "http://127.0.0.1:17878/predict";
const healthUrl = proxyUrl.replace(/\/predict$/, "/health");
const acceptUrl = proxyUrl.replace(/\/predict$/, "/accept");
const partialAcceptUrl = proxyUrl.replace(/\/predict$/, "/partial_accept");
const settingsPath =
  process.env.ZED_SETTINGS_PATH ?? path.join(os.homedir(), ".config", "zed", "settings.json");
const appPath = process.env.ZED_CURSOR_TAB_APP ?? "/Applications/Zed Preview Cursor Tab.app";
const zedRepoPath = process.env.ZED_REPO ?? path.resolve(process.cwd(), "..", "zed");
const launchAgentPath = path.join(os.homedir(), "Library", "LaunchAgents", "zed-cursor-tab-proxy.plist");
const apptivateHotkeysPath =
  process.env.APPTIVATE_HOTKEYS ?? path.join(os.homedir(), "Library", "Application Support", "Apptivate", "hotkeys");
const captureInput = process.env.ZED_CURSOR_PROXY_CAPTURE_INPUT ?? "captures/zed-cursor-tab";
const skipLiveProbe = process.env.ZED_CURSOR_VERIFY_SKIP_LIVE === "1";
const strictDailyDriver = process.env.ZED_CURSOR_VERIFY_STRICT_DAILY_DRIVER === "1";

const failures: string[] = [];
const warnings: string[] = [];

function run(name: string, cmd: string[], options: CommandOptions = {}): CommandResult {
  const result = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (!options.quiet) {
    console.log(`\n== ${name} ==`);
    if (stdout.trim()) {
      console.log(stdout.trim());
    }
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
  }
  return { name, status: result.exitCode, stdout, stderr };
}

async function checkProxyHealth() {
  console.log(`\n== proxy health ==`);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const response = await fetch(healthUrl);
      const body = await response.text();
      console.log(body);
      if (!response.ok) {
        failures.push(`proxy health returned HTTP ${response.status}`);
      }
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(100);
    }
  }

  failures.push(`proxy health failed after retries: ${lastError}`);
}

async function checkProxyAccept() {
  console.log(`\n== proxy fate endpoints ==`);
  try {
    const response = await fetch(acceptUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `verify-${Date.now()}` }),
    });
    const body = await response.text();
    console.log(body);
    if (!response.ok) {
      failures.push(`proxy accept returned HTTP ${response.status}`);
    }
  } catch (error) {
    failures.push(`proxy accept failed: ${error}`);
  }

  try {
    const response = await fetch(partialAcceptUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `verify-partial-${Date.now()}` }),
    });
    const body = await response.text();
    console.log(body);
    if (!response.ok) {
      failures.push(`proxy partial_accept returned HTTP ${response.status}`);
    }
  } catch (error) {
    failures.push(`proxy partial_accept failed: ${error}`);
  }
}

function stripJsonComments(source: string): string {
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

function readSettings() {
  if (!fs.existsSync(settingsPath)) {
    failures.push(`missing Zed settings file: ${settingsPath}`);
    return;
  }

  console.log(`\n== zed settings ==`);
  const settings = JSON.parse(
    stripJsonComments(fs.readFileSync(settingsPath, "utf8")).replace(/,\s*([}\]])/g, "$1"),
  );
  const editPredictions = settings.edit_predictions;
  console.log(JSON.stringify(editPredictions));

  if (editPredictions?.provider !== "external") {
    failures.push(`Zed edit_predictions.provider is not external`);
  }
  if (editPredictions?.external?.api_url !== proxyUrl) {
    failures.push(`Zed external api_url is not ${proxyUrl}`);
  }
}

function checkAppBundle() {
  console.log(`\n== app bundle ==`);
  if (!fs.existsSync(appPath)) {
    failures.push(`missing app bundle: ${appPath}`);
    return;
  }
  console.log(appPath);

  for (const executable of ["Contents/MacOS/zed", "Contents/MacOS/zed-bin", "Contents/MacOS/cli"]) {
    const executablePath = path.join(appPath, executable);
    if (!fs.existsSync(executablePath)) {
      failures.push(`missing app executable: ${executable}`);
    }
  }

  if (process.platform === "darwin") {
    const result = run(
      "codesign",
      ["codesign", "--verify", "--deep", "--strict", "--verbose=2", appPath],
      { quiet: true },
    );
    if (result.status !== 0) {
      failures.push(`codesign verification failed for ${appPath}`);
      console.error(result.stderr.trim() || result.stdout.trim());
    } else {
      console.log("codesign ok");
    }
  }
}

function gitHead(repoPath: string): string | null {
  if (!fs.existsSync(repoPath)) {
    return null;
  }

  const result = run("git rev-parse", ["git", "-C", repoPath, "rev-parse", "HEAD"], { quiet: true });
  if (result.status !== 0) {
    return null;
  }

  return result.stdout.trim() || null;
}

function checkInstallMetadata() {
  console.log(`\n== install metadata ==`);
  const metadataPath = path.join(appPath, "Contents", "Resources", "zed-cursor-tab.json");
  if (!fs.existsSync(metadataPath)) {
    failures.push(`missing app install metadata: ${metadataPath}`);
    return;
  }

  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  console.log(
    JSON.stringify({
      installed_at: metadata.installed_at,
      zed_commit: metadata.zed_commit,
      proxy_commit: metadata.proxy_commit,
      proxy_port: metadata.proxy_port,
    }),
  );

  const currentZedCommit = gitHead(zedRepoPath);
  const currentProxyCommit = gitHead(process.cwd());
  if (currentZedCommit && metadata.zed_commit && metadata.zed_commit !== currentZedCommit) {
    failures.push(
      `installed Zed commit ${metadata.zed_commit} does not match checkout ${currentZedCommit}; rerun install:zed-macos`,
    );
  }
  if (currentProxyCommit && metadata.proxy_commit && metadata.proxy_commit !== currentProxyCommit) {
    failures.push(
      `installed proxy commit ${metadata.proxy_commit} does not match checkout ${currentProxyCommit}; rerun install:zed-macos -- --no-build`,
    );
  }
  if (metadata.proxy_port !== Number(new URL(proxyUrl).port)) {
    failures.push(`installed proxy port ${metadata.proxy_port} does not match ${proxyUrl}`);
  }
}

function checkLaunchAgent() {
  if (process.platform !== "darwin") {
    return;
  }

  console.log(`\n== launch agent ==`);
  if (!fs.existsSync(launchAgentPath)) {
    failures.push(`missing proxy LaunchAgent: ${launchAgentPath}`);
    return;
  }
  console.log(launchAgentPath);

  const uid = process.getuid?.();
  if (uid == null) {
    warnings.push("cannot determine uid; skipping launchctl state check");
    return;
  }

  const result = run("launchctl", ["launchctl", "print", `gui/${uid}/zed-cursor-tab-proxy`], {
    quiet: true,
  });
  if (result.status !== 0) {
    failures.push("proxy LaunchAgent is not loaded");
    console.error(result.stderr.trim() || result.stdout.trim());
    return;
  }

  const output = result.stdout;
  const importantLines = output
    .split("\n")
    .filter((line) => /path =|type =|state =|properties =/.test(line))
    .join("\n");
  console.log(importantLines);
  if (!output.includes("type = LaunchAgent")) {
    failures.push("proxy launchctl job is not a LaunchAgent");
  }
  if (!output.includes("state = running")) {
    failures.push("proxy LaunchAgent is not running");
  }
  if (!output.includes("keepalive") || !output.includes("runatload")) {
    failures.push("proxy LaunchAgent is missing keepalive/runatload");
  }
}

function dailyDriverIssue(message: string) {
  if (strictDailyDriver) {
    failures.push(message);
  } else {
    warnings.push(message);
  }
}

function checkDailyDriverIntegration() {
  if (process.platform !== "darwin") {
    return;
  }

  console.log(`\n== daily driver integration ==`);

  let appUrl = pathToFileURL(appPath).href;
  if (!appUrl.endsWith("/")) {
    appUrl += "/";
  }

  const dock = run("dock", ["defaults", "read", "com.apple.dock", "persistent-apps"], { quiet: true });
  if (dock.status !== 0) {
    dailyDriverIssue("could not read Dock persistent apps");
  } else if (!dock.stdout.includes(appUrl)) {
    dailyDriverIssue(`${appPath} is not pinned in the Dock`);
  } else {
    console.log("Dock: pinned");
  }

  if (!fs.existsSync(apptivateHotkeysPath)) {
    dailyDriverIssue(`Apptivate hotkeys file not found: ${apptivateHotkeysPath}`);
    return;
  }

  const python = run("python3", ["python3", "--version"], { quiet: true });
  if (python.status !== 0) {
    dailyDriverIssue("python3 unavailable; cannot inspect Apptivate hotkeys");
    return;
  }
  const clang = run("clang", ["/usr/bin/clang", "--version"], { quiet: true });
  if (clang.status !== 0) {
    dailyDriverIssue("clang unavailable; cannot resolve Apptivate aliases");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-cursor-tab-verify-"));
  const script = `
import plistlib
import sys
from pathlib import Path

path = Path(sys.argv[1])
alias_path = Path(sys.argv[2])
with path.open("rb") as f:
    plist = plistlib.load(f)

objects = plist.get("$objects", [])

def uid_value(value):
    if isinstance(value, plistlib.UID):
        return value.data
    raise TypeError(f"expected UID, got {type(value)!r}")

for item in objects:
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
            alias_path.write_bytes(objects[uid_value(alias["$0"])])
            raise SystemExit(0)

raise SystemExit("missing Apptivate Ctrl-2 entry")
`;
  try {
    const aliasPath = path.join(tempDir, "target.alias");
    const apptivate = run("apptivate", ["python3", "-c", script, apptivateHotkeysPath, aliasPath], { quiet: true });
    if (apptivate.status !== 0) {
      dailyDriverIssue(apptivate.stderr.trim() || apptivate.stdout.trim() || "could not inspect Apptivate Ctrl-2");
      return;
    }

    const resolverPath = path.join(tempDir, "resolve_alias.c");
    const resolverBin = path.join(tempDir, "resolve_alias");
    fs.writeFileSync(
      resolverPath,
      `
#include <CoreServices/CoreServices.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/param.h>

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: resolve_alias ALIAS_FILE\\n");
    return 2;
  }

  FILE *file = fopen(argv[1], "rb");
  if (file == NULL) {
    perror("fopen");
    return 1;
  }
  if (fseek(file, 0, SEEK_END) != 0) {
    perror("fseek");
    fclose(file);
    return 1;
  }
  long size = ftell(file);
  if (size <= 0) {
    fprintf(stderr, "empty alias file\\n");
    fclose(file);
    return 1;
  }
  rewind(file);

  char *buffer = malloc((size_t)size);
  if (buffer == NULL) {
    fclose(file);
    return 1;
  }
  if (fread(buffer, 1, (size_t)size, file) != (size_t)size) {
    perror("fread");
    free(buffer);
    fclose(file);
    return 1;
  }
  fclose(file);

  Handle handle = NewHandle(size);
  if (handle == NULL) {
    free(buffer);
    return 1;
  }
  HLock(handle);
  memcpy(*handle, buffer, (size_t)size);
  HUnlock(handle);
  free(buffer);

  FSRef target;
  Boolean wasChanged = false;
  OSStatus err = FSResolveAlias(NULL, (AliasHandle)handle, &target, &wasChanged);
  DisposeHandle(handle);
  if (err != noErr) {
    fprintf(stderr, "FSResolveAlias failed: %d\\n", (int)err);
    return 1;
  }

  UInt8 resolvedPath[PATH_MAX];
  err = FSRefMakePath(&target, resolvedPath, sizeof(resolvedPath));
  if (err != noErr) {
    fprintf(stderr, "FSRefMakePath failed: %d\\n", (int)err);
    return 1;
  }

  printf("%s\\n", resolvedPath);
  return 0;
}
`,
    );

    const compile = run(
      "compile alias resolver",
      ["/usr/bin/clang", "-Wno-deprecated-declarations", "-framework", "CoreServices", resolverPath, "-o", resolverBin],
      { quiet: true },
    );
    if (compile.status !== 0) {
      dailyDriverIssue(compile.stderr.trim() || compile.stdout.trim() || "could not compile Apptivate alias resolver");
      return;
    }

    const resolved = run("resolve alias", [resolverBin, aliasPath], { quiet: true });
    if (resolved.status !== 0) {
      dailyDriverIssue(resolved.stderr.trim() || resolved.stdout.trim() || "could not resolve Apptivate Ctrl-2 alias");
      return;
    }
    const resolvedPath = resolved.stdout.trim();
    if (resolvedPath !== appPath) {
      dailyDriverIssue(`Apptivate Ctrl-2 points to ${resolvedPath}, not ${appPath}`);
      return;
    }
    console.log("Apptivate: Ctrl-2 points to patched app");
  } finally {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
}

function checkCommand(result: CommandResult) {
  if (result.status !== 0) {
    failures.push(`${result.name} failed with exit code ${result.status}`);
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".");
  if (!payload) {
    return null;
  }

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function checkCursorCredentials() {
  console.log(`\n== cursor credentials ==`);

  const token = process.env.CURSOR_BEARER_TOKEN ?? "";
  const sessionId = process.env.X_SESSION_ID ?? "";
  const clientVersion = process.env.X_CURSOR_CLIENT_VERSION ?? "";
  const requestId = process.env.X_REQUEST_ID ?? "";

  if (!fs.existsSync(path.join(process.cwd(), ".env"))) {
    warnings.push("cursor-unchained/.env is missing; relying only on the current process environment");
  }

  if (!token) {
    failures.push("CURSOR_BEARER_TOKEN is missing");
  } else {
    console.log("CURSOR_BEARER_TOKEN: present");
    const payload = decodeJwtPayload(token);
    const exp = typeof payload?.exp === "number" ? payload.exp : null;
    if (exp == null) {
      warnings.push("CURSOR_BEARER_TOKEN is not a decodable JWT; expiry could not be checked");
    } else {
      const expiresAt = new Date(exp * 1000);
      const msUntilExpiry = expiresAt.getTime() - Date.now();
      const daysUntilExpiry = msUntilExpiry / 86_400_000;
      console.log(`token_expires_at: ${expiresAt.toISOString()}`);
      if (msUntilExpiry <= 0) {
        failures.push("CURSOR_BEARER_TOKEN is expired");
      } else if (daysUntilExpiry < 7) {
        warnings.push(
          `CURSOR_BEARER_TOKEN expires soon: ${expiresAt.toISOString()} (${daysUntilExpiry.toFixed(1)} days)`,
        );
      }
    }
  }

  if (!sessionId) {
    failures.push("X_SESSION_ID is missing");
  } else {
    console.log("X_SESSION_ID: present");
  }

  if (!clientVersion) {
    failures.push("X_CURSOR_CLIENT_VERSION is missing");
  } else {
    console.log(`X_CURSOR_CLIENT_VERSION: ${clientVersion}`);
  }

  if (!requestId) {
    warnings.push("X_REQUEST_ID is missing; proxy will generate request IDs automatically");
  } else {
    console.log("X_REQUEST_ID: present");
  }
}

function parseLastJsonObject(output: string): any | null {
  const trimmed = output.trim();
  for (let index = 0; index < trimmed.length; index++) {
    const candidate = trimmed.slice(index).trim();
    if (!candidate.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function checkCaptureEval() {
  const result = run("capture eval", ["bun", "scripts/evalZedProxyCaptures.ts", captureInput]);
  checkCommand(result);
  const summary = parseLastJsonObject(result.stdout);
  if (!summary) {
    failures.push("capture eval did not print a JSON summary");
    return;
  }
  if (summary.duplicateRisk !== 0) {
    failures.push(`capture eval duplicateRisk is ${summary.duplicateRisk}`);
  }
  if (summary.deletedReintroductionRisk !== 0) {
    failures.push(`capture eval deletedReintroductionRisk is ${summary.deletedReintroductionRisk}`);
  }
  if (summary.capturedDeletedReintroductionRisk !== 0) {
    failures.push(
      `capture eval capturedDeletedReintroductionRisk is ${summary.capturedDeletedReintroductionRisk}`,
    );
  }
}

function checkLiveProbe() {
  if (skipLiveProbe) {
    console.log("\n== live probe ==\nskipped via ZED_CURSOR_VERIFY_SKIP_LIVE=1");
    return;
  }

  const result = run("live probe", ["bun", "scripts/probeZedProxy.ts"], {
    env: {
      ZED_CURSOR_PROXY_PROBE_ITERATIONS:
        process.env.ZED_CURSOR_PROXY_PROBE_ITERATIONS ?? "3",
      ZED_CURSOR_PROXY_MIN_AUTO_IMPORT_CHANGED:
        process.env.ZED_CURSOR_PROXY_MIN_AUTO_IMPORT_CHANGED ?? "1",
    },
  });
  checkCommand(result);
  const summaryLine = result.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((line) => line.includes('"summary"'));
  if (!summaryLine) {
    failures.push("live probe did not print a summary");
    return;
  }
  const summary = JSON.parse(summaryLine).summary;
  if (summary.failures?.length > 0) {
    failures.push(`live probe failures: ${summary.failures.join("; ")}`);
  }
  if (summary.changed < 1) {
    failures.push("live probe produced no changed predictions");
  }
}

readSettings();
checkAppBundle();
checkInstallMetadata();
checkCursorCredentials();
checkLaunchAgent();
checkDailyDriverIntegration();
await checkProxyHealth();
await checkProxyAccept();
checkCommand(run("unit tests", ["bun", "run", "test:zed-proxy"]));
checkCaptureEval();
checkLiveProbe();

console.log(`\n== summary ==`);
if (failures.length > 0) {
  for (const warning of warnings) {
    console.error(`WARN: ${warning}`);
  }
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

for (const warning of warnings) {
  console.warn(`WARN: ${warning}`);
}
console.log("Zed Cursor Tab verification passed.");
