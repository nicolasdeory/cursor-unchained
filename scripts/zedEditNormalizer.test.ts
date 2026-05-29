import { describe, expect, test } from "bun:test";
import {
  normalizeCursorEdit,
  normalizeCursorEdits,
  type ZedRequestForEdit,
} from "./zedEditNormalizer";

function applyEdit(contents: string, edit: NonNullable<ReturnType<typeof normalizeCursorEdit>>) {
  const lines = contents.split("\n");
  let startOffset = 0;
  for (let line = 0; line < edit.range.start.line; line++) {
    startOffset += lines[line].length + 1;
  }
  startOffset += edit.range.start.column;

  let endOffset = 0;
  for (let line = 0; line < edit.range.end.line; line++) {
    endOffset += lines[line].length + 1;
  }
  endOffset += edit.range.end.column;

  return contents.slice(0, startOffset) + edit.text + contents.slice(endOffset);
}

function applyEdits(contents: string, edits: NonNullable<ReturnType<typeof normalizeCursorEdit>>[]) {
  return [...edits]
    .sort((left, right) => {
      if (left.range.start.line !== right.range.start.line) {
        return right.range.start.line - left.range.start.line;
      }
      return right.range.start.column - left.range.start.column;
    })
    .reduce((next, edit) => applyEdit(next, edit), contents);
}

function request(contents: string, line: number, column: number): ZedRequestForEdit {
  return {
    path: "test.ts",
    contents,
    cursor: { line, column },
  };
}

describe("normalizeCursorEdit", () => {
  test("drops unchanged full-document responses", () => {
    const contents = "function add(a: number, b: number) {\n  return \n}\n";
    expect(
      normalizeCursorEdit(request(contents, 1, 9), {
        text: contents,
        rangeToReplace: null,
      }),
    ).toBeNull();
  });

  test("turns full-document prefix responses into minimal edits", () => {
    const contents = "function add(a: number, b: number) {\n  return \n}\n";
    const edit = normalizeCursorEdit(request(contents, 1, 9), {
      text: "function add(a: number, b: number) {\n  return a + b;\n}\n",
      rangeToReplace: null,
    });

    expect(edit).not.toBeNull();
    expect(edit?.text).toBe("a + b;");
    expect(applyEdit(contents, edit!)).toContain("return a + b;");
  });

  test("drops duplicate declaration blocks that already exist below", () => {
    const contents = [
      "    const matchingItems = [];",
      "",
      "    const selectedItemIds = new Set(matchingItems.map((item) => item.id));",
      "    const layoutEnabled = await settings.isEnabled(",
      "      ctx,",
      "      'layout_enabled',",
      "    );",
      "",
    ].join("\n");

    expect(
      normalizeCursorEdit(request(contents, 0, 16), {
        text: "\n    const selectedItemIds = new Set(matchingItems.map((item) => item.id));\n",
        rangeToReplace: null,
      }),
    ).toBeNull();
  });

  test("drops predictions that reintroduce recently deleted declarations", () => {
    const contents = [
      "    const remainingItemIds = new Set(items.map((item) => item.id));",
      "",
      "    return remainingItemIds;",
      "",
    ].join("\n");
    const requestWithDeletion: ZedRequestForEdit = {
      ...request(contents, 1, 4),
      cursor_request: {
        currentFile: { relativeWorkspacePath: "test.ts" },
        diffHistory: [
          [
            "@@ -1,6 +1,3 @@",
            " const remainingItemIds = new Set(items.map((item) => item.id));",
            "-const removedItemIds = new Set(items.map((item) => item.previousId));",
            "-const removedItemCount = removedItemIds.size;",
            "-",
            " return remainingItemIds;",
          ].join("\n"),
        ],
        fileDiffHistories: [],
      },
    };

    expect(
      normalizeCursorEdit(requestWithDeletion, {
        text: [
          "    const removedItemIds = new Set(items.map((item) => item.previousId));",
          "    const removedItemCount = removedItemIds.size;",
        ].join("\n"),
        rangeToReplace: null,
      }),
    ).toBeNull();
  });

  test("collapses repeated lines inside Cursor output", () => {
    const contents = ["    ", "", "    for (const item of items) {}", ""].join("\n");
    const edit = normalizeCursorEdit(request(contents, 0, 4), {
      text: "    const pendingUpdates: PendingUpdate[] = [];\n\n    const pendingUpdates: PendingUpdate[] = [];\n",
      rangeToReplace: null,
    });

    expect(edit).not.toBeNull();
    const next = applyEdit(contents, edit!);
    expect(next.match(/const pendingUpdates/g)?.length).toBe(1);
  });

  test("replaces the current line when the prediction matches the typed prefix", () => {
    const contents = [
      "    const selectedItemIds = new Set(matchingItems.map((item) => item.id));",
      "    const layoutEnabled = true;",
      "",
    ].join("\n");
    const edit = normalizeCursorEdit(request(contents, 0, 35), {
      text: "    const selectedItemIds = new Set(\n      matchingItems.map((item) => item.id),\n    );",
      rangeToReplace: null,
    });

    expect(edit).not.toBeNull();
    const next = applyEdit(contents, edit!);
    expect(next).toContain("const selectedItemIds = new Set(\n");
    expect(next.match(/const selectedItemIds/g)?.length).toBe(1);
    expect(next).toContain("const layoutEnabled = true;");
  });

  test("accepts block replacements when the typed prefix has trailing spaces", () => {
    const contents = [
      "    const candidateItemIds = sourceRows",
      "      .filter((row) => row.itemId)",
      "      .map((row) => nullthrows(row.itemId));",
      "",
      "    const matchingItems  ",
      "    const selectedItemIds = new Set(matchingItems.map((item) => item.id));",
      "    const layoutEnabled = true;",
      "",
    ].join("\n");
    const edit = normalizeCursorEdit(request(contents, 4, 20), {
      text: [
        "",
        "    const matchingItems = sourceRows.filter((row) =>",
        "      row.itemId.startsWith('visible-'),",
        "    );",
        "",
        "    const selectedItemIds = new Set(",
        "      matchingItems.map((item) => nullthrows(item.id)),",
        "    );",
      ].join("\n"),
      rangeToReplace: null,
    });

    expect(edit).not.toBeNull();
    const next = applyEdit(contents, edit!);
    expect(next).toContain("const matchingItems = sourceRows.filter");
    expect(next.match(/const selectedItemIds/g)?.length).toBe(1);
    expect(next).toContain("const layoutEnabled = true;");
  });

  test("preserves separated full-document changes as multiple edits", () => {
    const contents = [
      "import { a } from './a';",
      "",
      "const first = a();",
      "const middle = keep();",
      "const second = a();",
      "",
    ].join("\n");
    const predicted = [
      "import { a } from './a';",
      "import { b } from './b';",
      "",
      "const first = b();",
      "const middle = keep();",
      "const second = b();",
      "",
    ].join("\n");

    const edits = normalizeCursorEdits(request(contents, 2, 16), {
      text: predicted,
      rangeToReplace: null,
    });

    expect(edits.length).toBeGreaterThan(1);
    expect(applyEdits(contents, edits)).toBe(predicted);
  });

  test("accepts Cursor document-prefix fragments that add imports", () => {
    const contents = [
      "export function run(foo: string) {",
      "  return nullthrows(foo);",
      "}",
      "",
    ].join("\n");
    const cursorText = [
      "",
      'import { nullthrows } from "./utils/nullthrows";',
      "",
      "export function run(foo: string) {",
      '  return nullthrows(foo, "foo is required");',
    ].join("\n");

    const edits = normalizeCursorEdits(request(contents, 1, 25), {
      text: cursorText,
      rangeToReplace: null,
    });

    expect(edits.length).toBeGreaterThan(0);
    expect(applyEdits(contents, edits)).toBe(
      [
        'import { nullthrows } from "./utils/nullthrows";',
        "",
        "export function run(foo: string) {",
        '  return nullthrows(foo, "foo is required");',
        "}",
        "",
      ].join("\n"),
    );
  });
});
