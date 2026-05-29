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

function exactPayload(
  contents: string,
  cursor: Position,
  relPath: string,
  workspaceRoot: string,
  extra: Record<string, unknown> = {},
) {
  const lineEnding = contents.includes("\r\n") ? "\r\n" : "\n";
  const payload = {
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
  const extraCurrentFile =
    typeof extra.currentFile === "object" && extra.currentFile !== null
      ? (extra.currentFile as Record<string, unknown>)
      : {};

  return {
    ...payload,
    ...extra,
    currentFile: {
      ...payload.currentFile,
      ...extraCurrentFile,
    },
  };
}

async function runCase(
  name: string,
  contents: string,
  cursor: Position,
  absolutePath = "/tmp/test.ts",
  extraCursorPayload: Record<string, unknown> = {},
  iteration = 1,
) {
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
    cursor_request: exactPayload(contents, cursor, relPath, workspaceRoot, extraCursorPayload),
  };

  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const elapsedMs = performance.now() - started;
  const json = (await response.json()) as {
    id?: string;
    id_source?: "cursor" | "synthetic";
    edits?: Edit[];
    jump?: unknown;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(`${name}: HTTP ${response.status}: ${json.error ?? "unknown error"}`);
  }

  const edits = json.edits ?? [];
  const next = applyEdits(contents, edits);
  const result = {
    name,
    iteration,
    latencyMs: Math.round(elapsedMs),
    edits: edits.length,
    changed: next !== contents,
    idSource: json.id_source ?? "missing",
    hasJump: Boolean(json.jump),
    selectedItemIds: declarationCount(next, "selectedItemIds"),
    pendingUpdates: declarationCount(next, "pendingUpdates"),
    removedItemIds: declarationCount(next, "removedItemIds"),
    removedItemCount: declarationCount(next, "removedItemCount"),
    firstEditRange: edits[0]?.range ?? null,
    firstEditTextLength: edits[0]?.text.length ?? 0,
    firstEditPreview: edits[0]?.text.slice(0, 160) ?? "",
    insertedImport: /\bimport\s+.*\bnullthrows\b/.test(next),
  };
  console.log(JSON.stringify(result));
  return result;
}

const simple = "function add(a: number, b: number) {\n  return \n}\n";

const duplicateSensitive = [
  "    const candidateItemIds = sourceRows",
  "      .filter((row) => row.itemId)",
  "      .map((row) => nullthrows(row.itemId));",
  "",
  "    const matchingItems =",
  "      candidateItemIds.length > 0",
  "        ? await itemLookup.findMany({",
  "            where: {",
  "              id: { in: candidateItemIds },",
  "              group: { in: VISIBLE_GROUPS },",
  "            },",
  "            select: { id: true },",
  "          })",
  "        : [];",
  "",
  "    const selectedItemIds = new Set(matchingItems.map((item) => item.id));",
  "    const layoutEnabled = await settings.isEnabled(",
  "      ctx,",
  "      'layout_enabled',",
  "    );",
  "",
  "    const pendingUpdates: PendingUpdate[] = [];",
  "",
].join("\n");

const deletionSensitive = [
  "    const remainingItemIds = new Set(items.map((item) => item.id));",
  "",
  "    return remainingItemIds;",
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

const autoImportDiagnostic = [
  "export function run(foo: string) {",
  "  return nullthrows(foo);",
  "}",
  "",
].join("\n");

const nullthrowsHelper = [
  "export function nullthrows<T>(value: T | null | undefined, message = 'Unexpected null'): T {",
  "  if (value == null) {",
  "    throw new Error(message);",
  "  }",
  "  return value;",
  "}",
  "",
].join("\n");

const cases = [
  {
    name: "simple-return",
    contents: simple,
    cursor: { line: 1, column: 9 },
  },
  {
    name: "duplicate-sensitive-collection",
    contents: duplicateSensitive,
    cursor: { line: 4, column: 18 },
  },
  {
    name: "duplicate-sensitive-selection",
    contents: duplicateSensitive,
    cursor: { line: 15, column: 0 },
  },
  {
    name: "deletion-sensitive",
    contents: deletionSensitive,
    cursor: { line: 1, column: 4 },
    absolutePath: "/tmp/test.ts",
    extraCursorPayload: {
      diffHistory: [deletionDiff],
      fileDiffHistories: [
        {
          fileName: "test.ts",
          diffHistory: [deletionDiff],
          diffHistoryTimestamps: [Date.now()],
        },
      ],
    },
  },
  {
    name: "auto-import-diagnostic-shape",
    contents: autoImportDiagnostic,
    cursor: { line: 1, column: 25 },
    absolutePath: "/tmp/test.ts",
    extraCursorPayload: {
      currentFile: {
        diagnostics: [
          {
            message: "Cannot find name 'nullthrows'.",
            range: {
              startLine: 1,
              startColumn: 9,
              endLine: 1,
              endColumn: 19,
            },
            severity: 1,
            relatedInformation: [],
          },
        ],
      },
      lspSuggestedItems: {
        suggestions: [{ label: "nullthrows" }],
      },
      additionalFiles: [
        {
          relativeWorkspacePath: "utils/nullthrows.ts",
          isOpen: true,
          visibleRangeContent: [nullthrowsHelper],
          startLineNumberOneIndexed: [1],
          visibleRanges: [
            {
              startLineNumber: 1,
              endLineNumberInclusive: nullthrowsHelper.split("\n").length,
            },
          ],
        },
      ],
      codeResults: [
        {
          codeBlock: {
            relativeWorkspacePath: "utils/nullthrows.ts",
            range: {
              startPosition: { line: 0, column: 0 },
              endPosition: { line: nullthrowsHelper.split("\n").length, column: 0 },
            },
            contents: nullthrowsHelper,
          },
          score: 0.95,
        },
      ],
    },
  },
];

function percentile(values: number[], p: number) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

const iterations = Math.max(
  1,
  Number(process.env.ZED_CURSOR_PROXY_PROBE_ITERATIONS ?? "1"),
);
const results = [];
for (let iteration = 1; iteration <= iterations; iteration++) {
  for (const testCase of cases) {
    results.push(
      await runCase(
        testCase.name,
        testCase.contents,
        testCase.cursor,
        testCase.absolutePath,
        testCase.extraCursorPayload,
        iteration,
      ),
    );
  }
}

const maxLatencyMs = Number(process.env.ZED_CURSOR_PROXY_MAX_LATENCY_MS ?? "2500");
const minChanged = Number(process.env.ZED_CURSOR_PROXY_MIN_CHANGED ?? String(iterations));
const failures: string[] = [];
for (const result of results) {
  if (result.latencyMs > maxLatencyMs) {
    failures.push(`${result.name}: latency ${result.latencyMs}ms > ${maxLatencyMs}ms`);
  }
  if ((result.changed || result.hasJump) && result.idSource !== "cursor") {
    failures.push(`${result.name}: shown prediction id source is ${result.idSource}`);
  }
}

const duplicateCollections = results.filter(
  (result) => result.name === "duplicate-sensitive-selection",
);
if (duplicateCollections.some((result) => result.selectedItemIds > 1)) {
  failures.push("duplicate-sensitive-selection duplicated selectedItemIds");
}
if (duplicateCollections.some((result) => result.pendingUpdates > 1)) {
  failures.push("duplicate-sensitive-selection duplicated pendingUpdates");
}

const deletionCollections = results.filter((result) => result.name === "deletion-sensitive");
if (deletionCollections.some((result) => result.removedItemIds > 0)) {
  failures.push("deletion-sensitive reintroduced removedItemIds");
}
if (deletionCollections.some((result) => result.removedItemCount > 0)) {
  failures.push("deletion-sensitive reintroduced removedItemCount");
}

const autoImportCollections = results.filter(
  (result) => result.name === "auto-import-diagnostic-shape",
);
const autoImportChanged = autoImportCollections.filter(
  (result) => result.changed && result.insertedImport,
).length;
const minAutoImportChanged = Number(process.env.ZED_CURSOR_PROXY_MIN_AUTO_IMPORT_CHANGED ?? "0");
if (autoImportChanged < minAutoImportChanged) {
  failures.push(
    `auto-import changed predictions ${autoImportChanged} < ${minAutoImportChanged}`,
  );
}

const changed = results.filter((result) => result.changed).length;
const cursorBackedIds = results.filter(
  (result) => (result.changed || result.hasJump) && result.idSource === "cursor",
).length;
if (changed < minChanged) {
  failures.push(`changed predictions ${changed} < ${minChanged}`);
}

const latencies = results.map((result) => result.latencyMs);
console.log(
  JSON.stringify({
    summary: {
      iterations,
      cases: cases.length,
      requests: results.length,
      changed,
      autoImportChanged,
      cursorBackedIds,
      latencyMs: {
        min: Math.min(...latencies),
        p50: percentile(latencies, 0.5),
        p90: percentile(latencies, 0.9),
        p95: percentile(latencies, 0.95),
        max: Math.max(...latencies),
      },
      maxLatencyMs: Math.max(...latencies),
      failures,
    },
  }),
);

if (failures.length > 0) {
  process.exitCode = 1;
}
