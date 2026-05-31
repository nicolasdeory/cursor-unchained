import { describe, expect, test } from "bun:test";
import {
  cursorDiffHistoryFromUnifiedDiff,
  normalizeCursorContextPaths,
  normalizeDiffHistoryTimestamps,
  normalizeFileDiffHistories,
  refreshTabContextPayloadFromStream,
} from "./cursorPayloadUtils";

describe("cursor payload utilities", () => {
  test("converts unified diffs to Cursor diff history format", () => {
    expect(
      cursorDiffHistoryFromUnifiedDiff(
        [
          "--- a/src/file.ts",
          "+++ b/src/file.ts",
          "@@ -3,2 +3,2 @@",
          "-old",
          "+new",
          " context",
          "+added",
        ].join("\n"),
      ),
    ).toBe(["3-|old", "3+|new", "5+|added"].join("\n"));
  });

  test("replaces zero timestamps from Zed with recent ordered timestamps", () => {
    expect(normalizeDiffHistoryTimestamps([0, 0, 0], 3, 1_700_000_000_000)).toEqual([
      1_699_999_998_000,
      1_699_999_999_000,
      1_700_000_000_000,
    ]);
  });

  test("preserves valid Cursor timestamps", () => {
    expect(normalizeDiffHistoryTimestamps([10, 20], 2, 1_700_000_000_000)).toEqual([
      10,
      20,
    ]);
  });

  test("normalizes file diff history timestamps and diff text in place", () => {
    const payload = {
      fileDiffHistories: [
        {
          fileName: "src/file.ts",
          diffHistory: ["@@ -1 +1 @@\n-old\n+new"],
          diffHistoryTimestamps: [0],
        },
      ],
      diffHistory: ["@@ -2 +2 @@\n-before\n+after"],
    };

    normalizeFileDiffHistories(payload, 1_700_000_000_000);

    expect(payload.fileDiffHistories[0].diffHistory).toEqual(["1-|old\n1+|new"]);
    expect(payload.fileDiffHistories[0].diffHistoryTimestamps).toEqual([1_700_000_000_000]);
    expect(payload.diffHistory).toEqual(["2-|before\n2+|after"]);
  });

  test("normalizes Zed project-prefixed context paths to workspace-relative paths", () => {
    const payload = {
      workspaceId: "/Users/example/projects/acme-monorepo",
      currentFile: {
        workspaceRootPath: "/Users/example/projects/acme-monorepo",
        relativeWorkspacePath: "frontend/src/file.ts",
      },
      fileDiffHistories: [
        { fileName: "acme-monorepo/frontend/src/file.ts" },
        {
          fileName:
            "/Users/example/projects/acme-monorepo/backend/src/service.ts",
        },
      ],
      additionalFiles: [
        { relativeWorkspacePath: "acme-monorepo/package.json" },
      ],
      codeResults: [
        {
          codeBlock: {
            relativeWorkspacePath: "acme-monorepo/frontend/src/other.ts",
          },
        },
      ],
    };

    normalizeCursorContextPaths(payload);

    expect(payload.fileDiffHistories.map((history) => history.fileName)).toEqual([
      "frontend/src/file.ts",
      "backend/src/service.ts",
    ]);
    expect(payload.additionalFiles[0].relativeWorkspacePath).toBe("package.json");
    expect(payload.codeResults[0].codeBlock.relativeWorkspacePath).toBe(
      "frontend/src/other.ts",
    );
  });

  test("builds refresh payloads without StreamCpp-only linter errors", () => {
    const payload = refreshTabContextPayloadFromStream(
      {
        currentFile: {
          relativeWorkspacePath: "src/file.ts",
          diagnostics: [{ message: "Cannot find name", severity: 1 }],
        },
        linterErrors: {
          relativeWorkspacePath: "src/file.ts",
          errors: [{ message: "Cannot find name", severity: 1 }],
        },
        fileDiffHistories: [{ fileName: "src/file.ts", diffHistory: [] }],
        supportsCpt: true,
      },
      {
        now: 1_700_000_000_000,
        modelName: "fast",
        workspaceId: "workspace",
        supportsCpt: false,
        supportsCrlfCpt: false,
      },
    );

    expect(payload).not.toHaveProperty("linterErrors");
    expect(payload.currentFile.diagnostics).toHaveLength(1);
    expect(payload.fileDiffHistories).toHaveLength(1);
    expect(payload.supportsCpt).toBe(true);
    expect(payload.supportsCrlfCpt).toBe(true);
  });
});
