import fs from "node:fs";
import path from "node:path";
import { normalizeCursorEdits, type ZedRequestForEdit } from "./zedEditNormalizer";

type Position = { line: number; column: number };
type Edit = { range: { start: Position; end: Position }; text: string };
type CaptureRecord = {
  latencyMs?: number;
  relativePath?: string;
  request: ZedRequestForEdit & { cursor_request?: unknown; cursorRequest?: unknown };
  cursorResult: {
    text: string;
    rangeToReplace?: {
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    } | null;
    cursorPredictionTarget?: unknown;
    source?: string;
  };
  zedResponse?: { edits?: Edit[]; jump?: unknown };
};

function captureInputs(): string[] {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return args;
  }
  return ["captures/zed-cursor-tab"];
}

function filesForInput(input: string): string[] {
  if (!fs.existsSync(input)) {
    return [];
  }
  const stat = fs.statSync(input);
  if (stat.isFile()) {
    return [input];
  }
  return fs
    .readdirSync(input)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(input, name))
    .sort();
}

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

function applyEdit(contents: string, edit: Edit) {
  const start = offsetForPosition(contents, edit.range.start);
  const end = offsetForPosition(contents, edit.range.end);
  return contents.slice(0, start) + edit.text + contents.slice(end);
}

function applyEdits(contents: string, edits: Edit[]) {
  return [...edits]
    .sort(
      (left, right) =>
        offsetForPosition(contents, right.range.start) -
        offsetForPosition(contents, left.range.start),
    )
    .reduce((next, edit) => applyEdit(next, edit), contents);
}

function declarationCounts(contents: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of contents.split("\n")) {
    const match = line.match(
      /^\s*(?:export\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/,
    );
    if (match) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
  }
  return counts;
}

function newDuplicateDeclarations(before: string, after: string): string[] {
  const beforeCounts = declarationCounts(before);
  const afterCounts = declarationCounts(after);
  const duplicates: string[] = [];
  for (const [name, afterCount] of afterCounts) {
    const beforeCount = beforeCounts.get(name) ?? 0;
    if (afterCount > Math.max(1, beforeCount)) {
      duplicates.push(name);
    }
  }
  return duplicates;
}

function percentile(values: number[], p: number) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

const records: CaptureRecord[] = [];
for (const input of captureInputs()) {
  for (const file of filesForInput(input)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      records.push(JSON.parse(line));
    }
  }
}

let rawNonEmpty = 0;
let normalizedShown = 0;
let changed = 0;
let multiEdit = 0;
let duplicateRisk = 0;
let punctuationOnly = 0;
let replayMismatch = 0;
const latencies: number[] = [];
const sourceCounts = new Map<string, number>();
const riskyExamples: Array<Record<string, unknown>> = [];

for (const record of records) {
  const request = record.request;
  const result = record.cursorResult;
  if (record.latencyMs != null) {
    latencies.push(record.latencyMs);
  }
  sourceCounts.set(result.source ?? "unknown", (sourceCounts.get(result.source ?? "unknown") ?? 0) + 1);
  if (result.text) {
    rawNonEmpty++;
  }

  const edits = normalizeCursorEdits(request, result);
  const capturedEdits = record.zedResponse?.edits ?? [];
  if (edits.length !== capturedEdits.length) {
    replayMismatch++;
  } else if (
    edits.some(
      (edit, index) =>
        JSON.stringify(edit.range) !== JSON.stringify(capturedEdits[index]?.range) ||
        edit.text !== capturedEdits[index]?.text,
    )
  ) {
    replayMismatch++;
  }

  if (edits.length === 0) {
    continue;
  }

  normalizedShown++;
  if (edits.length > 1) {
    multiEdit++;
  }
  if (!edits.some((edit) => /[A-Za-z0-9_$]/.test(edit.text))) {
    punctuationOnly++;
  }
  const next = applyEdits(request.contents, edits);
  if (next !== request.contents) {
    changed++;
  }
  const duplicates = newDuplicateDeclarations(request.contents, next);
  if (duplicates.length > 0) {
    duplicateRisk++;
    riskyExamples.push({
      path: record.relativePath,
      cursor: request.cursor,
      duplicates,
      textPreview: edits.map((edit) => edit.text).join("\n---\n").slice(0, 180),
    });
  }
}

const summary = {
  records: records.length,
  rawNonEmpty,
  normalizedShown,
  changed,
  multiEdit,
  rawShowRate: records.length ? rawNonEmpty / records.length : 0,
  normalizedShowRate: records.length ? normalizedShown / records.length : 0,
  duplicateRisk,
  punctuationOnly,
  replayMismatch,
  sourceCounts: Object.fromEntries(sourceCounts),
  latencyMs: {
    min: latencies.length ? Math.min(...latencies) : null,
    p50: percentile(latencies, 0.5),
    p90: percentile(latencies, 0.9),
    p95: percentile(latencies, 0.95),
    max: latencies.length ? Math.max(...latencies) : null,
  },
  riskyExamples: riskyExamples.slice(0, 10),
};

console.log(JSON.stringify(summary, null, 2));
