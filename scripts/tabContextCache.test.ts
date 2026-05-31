import { describe, expect, test } from "bun:test";
import {
  TabContextCache,
  exactTabContextCacheKey,
  fileTabContextCacheKey,
  tabContextCacheInput,
} from "./tabContextCache";

describe("tab context cache", () => {
  test("reuses Cursor index results across nearby edits in the same file", () => {
    const cache = new TabContextCache();
    const original = tabContextCacheInput({
      workspaceId: "workspace",
      relativeWorkspacePath: "src/file.ts",
      line: 10,
      column: 4,
      contents: "const value = old;",
    });
    const edited = tabContextCacheInput({
      ...original,
      column: 8,
      contents: "const value = older;",
    });
    const codeResults = [{ codeBlock: { relativeWorkspacePath: "src/other.ts" } }];

    cache.set(original, codeResults, 1_000);

    expect(exactTabContextCacheKey(original)).not.toBe(exactTabContextCacheKey(edited));
    expect(fileTabContextCacheKey(original)).toBe(fileTabContextCacheKey(edited));
    expect(cache.get(edited, 30_000, 2_000)).toEqual({
      source: "file",
      codeResults,
    });
  });

  test("expires stale file-level index results", () => {
    const cache = new TabContextCache();
    const input = tabContextCacheInput({
      workspaceId: "workspace",
      relativeWorkspacePath: "src/file.ts",
      contents: "const value = old;",
    });

    cache.set(input, [{ codeBlock: {} }], 1_000);

    expect(cache.get(input, 30_000, 31_000)).toBeNull();
  });
});
