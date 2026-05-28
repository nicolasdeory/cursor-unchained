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
  const response = await fetch(healthUrl);
  const body = await response.text();
  console.log(body);
  if (!response.ok) {
    failures.push(`proxy health returned HTTP ${response.status}`);
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
await checkProxyHealth();
checkCommand(run("unit tests", ["bun", "run", "test:zed-proxy"]));
checkCaptureEval();
checkLiveProbe();

console.log(`\n== summary ==`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log("Zed Cursor Tab verification passed.");
