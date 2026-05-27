import path from "node:path";

type Position = { line: number; column: number };
type Edit = { range: { start: Position; end: Position }; text: string };

const endpoint = process.env.ZED_CURSOR_PROXY_URL ?? "http://127.0.0.1:17878/predict";

function offsetForPosition(contents: string, position: Position): number {
  let offset = 0;
  let line = 0;
  for (const segment of contents.split("\n")) {
    if (line === position.line) {
      return offset + Math.min(position.column, segment.length);
    }
    offset += segment.length + 1;
    line++;
  }
  return contents.length;
}

function applyEdits(contents: string, edits: Edit[]) {
  return [...edits]
    .sort(
      (left, right) =>
        offsetForPosition(contents, right.range.start) -
        offsetForPosition(contents, left.range.start),
    )
    .reduce((next, edit) => {
      const start = offsetForPosition(next, edit.range.start);
      const end = offsetForPosition(next, edit.range.end);
      return next.slice(0, start) + edit.text + next.slice(end);
    }, contents);
}

function declarationCount(contents: string, name: string) {
  return contents
    .split("\n")
    .filter((line) =>
      new RegExp(`^\\s*(?:const|let|var|function|class|interface|type)\\s+${name}\\b`).test(
        line,
      ),
    ).length;
}

function exactPayload(contents: string, cursor: Position, relPath: string, workspaceRoot: string) {
  const lineEnding = contents.includes("\r\n") ? "\r\n" : "\n";
  return {
    currentFile: {
      relativeWorkspacePath: relPath,
      contents,
      cursorPosition: cursor,
      dataframes: [],
      languageId: "typescript",
      diagnostics: [],
      totalNumberOfLines: contents.split(lineEnding).length,
      contentsStartAtLine: 0,
      topChunks: [],
      fileVersion: 1,
      cellStartLines: [],
      cells: [],
      relyOnFilesync: false,
      workspaceRootPath: workspaceRoot,
      lineEnding,
    },
    diffHistory: [],
    diffHistoryKeys: [],
    fileDiffHistories: [],
    mergedDiffHistories: [],
    blockDiffPatches: [],
    contextItems: [],
    parameterHints: [],
    lspContexts: [],
    cppIntentInfo: { source: "line_change" },
    enableMoreContext: true,
    workspaceId: workspaceRoot,
    additionalFiles: [],
    clientTime: 0,
    filesyncUpdates: [],
    timeSinceRequestStart: 0,
    timeAtRequestSend: 0,
    clientTimezoneOffset: 0,
    lspSuggestedItems: { suggestions: [] },
    supportsCpt: false,
    supportsCrlfCpt: false,
    codeResults: [],
  };
}

async function runCase(name: string, contents: string, cursor: Position, absolutePath = "/tmp/test.ts") {
  const workspaceRoot = path.dirname(absolutePath);
  const relPath = path.basename(absolutePath);
  const body = {
    version: 1,
    path: absolutePath,
    absolute_path: absolutePath,
    workspace_root: workspaceRoot,
    language: "TypeScript",
    contents,
    cursor,
    cursor_request: exactPayload(contents, cursor, relPath, workspaceRoot),
  };

  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const elapsedMs = performance.now() - started;
  const json = (await response.json()) as { edits?: Edit[]; error?: string };
  if (!response.ok) {
    throw new Error(`${name}: HTTP ${response.status}: ${json.error ?? "unknown error"}`);
  }

  const edits = json.edits ?? [];
  const next = applyEdits(contents, edits);
  console.log(
    JSON.stringify({
      name,
      latencyMs: Math.round(elapsedMs),
      edits: edits.length,
      changed: next !== contents,
      selectedProductIds: declarationCount(next, "selectedProductIds"),
      plannedMerges: declarationCount(next, "plannedMerges"),
      firstEditRange: edits[0]?.range ?? null,
      firstEditTextLength: edits[0]?.text.length ?? 0,
      firstEditPreview: edits[0]?.text.slice(0, 160) ?? "",
    }),
  );
}

const simple = "function add(a: number, b: number) {\n  return \n}\n";

const duplicateSensitive = [
  "    const allProductIds = orderLines",
  "      .filter((line) => line.productId)",
  "      .map((line) => nullthrows(line.productId));",
  "",
  "    const matchingProducts =",
  "      allProductIds.length > 0",
  "        ? await this.productService.findMany({",
  "            where: {",
  "              id: { in: allProductIds },",
  "              category: { in: FEATURED_CATEGORY_SLUGS },",
  "            },",
  "            select: { id: true },",
  "          })",
  "        : [];",
  "",
  "    const selectedProductIds = new Set(matchingProducts.map((product) => product.id));",
  "    const groupingEnabled = await this.featureFlagService.enabled(",
  "      ctx,",
  "      'grouping_enabled',",
  "    );",
  "",
  "    const plannedMerges: PlannedMerge[] = [];",
  "",
].join("\n");

await runCase("simple-return", simple, { line: 1, column: 9 });
await runCase("duplicate-sensitive-collection", duplicateSensitive, { line: 4, column: 18 });
await runCase("duplicate-sensitive-selection", duplicateSensitive, { line: 15, column: 0 });
