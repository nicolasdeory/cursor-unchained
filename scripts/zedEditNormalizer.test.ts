import { describe, expect, test } from "bun:test";
import { normalizeCursorEdit, type ZedRequestForEdit } from "./zedEditNormalizer";

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
      "    const matchingProducts = [];",
      "",
      "    const selectedProductIds = new Set(matchingProducts.map((product) => product.id));",
      "    const groupingEnabled = await this.featureFlagService.enabled(",
      "      ctx,",
      "      'grouping_enabled',",
      "    );",
      "",
    ].join("\n");

    expect(
      normalizeCursorEdit(request(contents, 0, 16), {
        text: "\n    const selectedProductIds = new Set(matchingProducts.map((product) => product.id));\n",
        rangeToReplace: null,
      }),
    ).toBeNull();
  });

  test("collapses repeated lines inside Cursor output", () => {
    const contents = ["    ", "", "    for (const item of items) {}", ""].join("\n");
    const edit = normalizeCursorEdit(request(contents, 0, 4), {
      text: "    const plannedMerges: PlannedMerge[] = [];\n\n    const plannedMerges: PlannedMerge[] = [];\n",
      rangeToReplace: null,
    });

    expect(edit).not.toBeNull();
    const next = applyEdit(contents, edit!);
    expect(next.match(/const plannedMerges/g)?.length).toBe(1);
  });

  test("replaces the current line when the prediction matches the typed prefix", () => {
    const contents = [
      "    const selectedProductIds = new Set(matchingProducts.map((product) => product.id));",
      "    const groupingEnabled = true;",
      "",
    ].join("\n");
    const edit = normalizeCursorEdit(request(contents, 0, 39), {
      text: "    const selectedProductIds = new Set(\n      matchingProducts.map((product) => product.id),\n    );",
      rangeToReplace: null,
    });

    expect(edit).not.toBeNull();
    const next = applyEdit(contents, edit!);
    expect(next).toContain("const selectedProductIds = new Set(\n");
    expect(next.match(/const selectedProductIds/g)?.length).toBe(1);
    expect(next).toContain("const groupingEnabled = true;");
  });

  test("accepts block replacements when the typed prefix has trailing spaces", () => {
    const contents = [
      "    const allProductIds = orderLines",
      "      .filter((line) => line.productId)",
      "      .map((line) => nullthrows(line.productId));",
      "",
      "    const matchingProducts  ",
      "    const selectedProductIds = new Set(matchingProducts.map((product) => product.id));",
      "    const groupingEnabled = true;",
      "",
    ].join("\n");
    const edit = normalizeCursorEdit(request(contents, 4, 20), {
      text: [
        "",
        "    const matchingProducts = orderLines.filter((line) =>",
        "      line.productId.startsWith('featured-'),",
        "    );",
        "",
        "    const selectedProductIds = new Set(",
        "      matchingProducts.map((product) => nullthrows(product.id)),",
        "    );",
      ].join("\n"),
      rangeToReplace: null,
    });

    expect(edit).not.toBeNull();
    const next = applyEdit(contents, edit!);
    expect(next).toContain("const matchingProducts = orderLines.filter");
    expect(next.match(/const selectedProductIds/g)?.length).toBe(1);
    expect(next).toContain("const groupingEnabled = true;");
  });
});
