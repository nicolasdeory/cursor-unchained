import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("evalZedProxyCaptures", () => {
  test("reports captured responses that reintroduce recently deleted declarations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zed-proxy-eval-"));
    const file = path.join(dir, "capture.jsonl");
    const contents = [
      "const remainingItemIds = new Set(items.map((item) => item.id));",
      "",
      "return remainingItemIds;",
      "",
    ].join("\n");
    const deletedText = [
      "const removedItemIds = new Set(items.map((item) => item.previousId));",
      "const removedItemCount = removedItemIds.size;",
      "",
    ].join("\n");
    const deletionDiff = [
      "@@ -1,6 +1,3 @@",
      " const remainingItemIds = new Set(items.map((item) => item.id));",
      "-const removedItemIds = new Set(items.map((item) => item.previousId));",
      "-const removedItemCount = removedItemIds.size;",
      "-",
      " return remainingItemIds;",
    ].join("\n");

    const record = {
      relativePath: "test.ts",
      request: {
        path: "test.ts",
        contents,
        cursor: { line: 1, column: 0 },
        cursor_request: {
          currentFile: { relativeWorkspacePath: "test.ts" },
          diffHistory: [deletionDiff],
          fileDiffHistories: [],
        },
      },
      cursorResult: {
        text: deletedText,
        rangeToReplace: null,
        source: "exact",
      },
      zedResponse: {
        edits: [
          {
            range: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
            text: deletedText,
          },
        ],
      },
    };

    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    const result = Bun.spawnSync({
      cmd: ["bun", "scripts/evalZedProxyCaptures.ts", file],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      expect(result.exitCode).toBe(0);
      const summary = JSON.parse(new TextDecoder().decode(result.stdout));
      expect(summary.normalizedShown).toBe(0);
      expect(summary.deletedReintroductionRisk).toBe(0);
      expect(summary.capturedDeletedReintroductionRisk).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
