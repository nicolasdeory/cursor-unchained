import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";

let proxyProcess: ReturnType<typeof Bun.spawn> | null = null;
let proxyStdout = "";
let proxyStderr = "";

async function readStream(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) {
    return "";
  }
  return await new Response(stream).text();
}

async function openPort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
        } else {
          reject(new Error("failed to allocate local port"));
        }
      });
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port: number) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`proxy did not become healthy: ${lastError}`);
}

async function startMockProxy(mockResult: Record<string, unknown>) {
  const port = await openPort();
  proxyProcess = Bun.spawn({
    cmd: ["bun", "run", "scripts/zedExternalProxy.ts"],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ZED_CURSOR_PROXY_PORT: String(port),
      ZED_CURSOR_PROXY_ACCEPT_TELEMETRY: "0",
      ZED_CURSOR_PROXY_MOCK_RESULT: JSON.stringify(mockResult),
    },
  });
  const stdout = readStream(proxyProcess.stdout);
  const stderr = readStream(proxyProcess.stderr);
  try {
    await waitForHealth(port);
  } catch (error) {
    proxyProcess.kill();
    proxyStdout = await stdout;
    proxyStderr = await stderr;
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nstdout:\n${proxyStdout}\nstderr:\n${proxyStderr}`,
    );
  }
  return port;
}

afterEach(() => {
  proxyProcess?.kill();
  proxyProcess = null;
});

describe("Zed external proxy HTTP path", () => {
  test("returns Cursor prediction targets as jump-only Zed responses", async () => {
    const port = await startMockProxy({
      bindingId: "jump-binding-through-http",
      text: "  return 1;\n",
      cursorPredictionTarget: {
        relativePath: "src/other.ts",
        lineNumberOneIndexed: 4,
        expectedContent: "export const target = 1;",
        shouldRetriggerCpp: true,
      },
    });

    const response = await fetch(`http://127.0.0.1:${port}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        path: "src/test.ts",
        language: "TypeScript",
        contents: "export function main() {\n  return \n}\n",
        cursor: { line: 1, column: 9 },
      }),
    });

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({
      id: "jump-binding-through-http",
      id_source: "cursor",
      edits: [],
      jump: {
        path: "src/other.ts",
        expected_content: "export const target = 1;",
        should_retrigger: true,
        position: { line: 3, column: 0 },
      },
    });
  });
});
