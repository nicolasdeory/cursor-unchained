import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CommandResult = {
  name: string;
  status: number;
  stdout: string;
  stderr: string;
};

const proxyUrl = process.env.ZED_CURSOR_PROXY_URL ?? "http://127.0.0.1:17878/predict";
const healthUrl = proxyUrl.replace(/\/predict$/, "/health");
const settingsPath =
  process.env.ZED_SETTINGS_PATH ?? path.join(os.homedir(), ".config", "zed", "settings.json");
const appPath = process.env.ZED_CURSOR_TAB_APP ?? "/Applications/Zed Preview Cursor Tab.app";
const captureInput = process.env.ZED_CURSOR_PROXY_CAPTURE_INPUT ?? "captures/zed-cursor-tab";
const skipLiveProbe = process.env.ZED_CURSOR_VERIFY_SKIP_LIVE === "1";

const failures: string[] = [];
const warnings: string[] = [];

function run(name: string, cmd: string[], options: { quiet?: boolean } = {}): CommandResult {
  const result = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
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

  const result = run("live probe", ["bun", "scripts/probeZedProxy.ts"]);
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
}

readSettings();
checkAppBundle();
checkCursorCredentials();
await checkProxyHealth();
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
