import protobuf from "protobufjs";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import { defaultStreamCppPayload } from "../src/lib/constants";
import { normalizeFileDiffHistories } from "./cursorPayloadUtils";
import { toZedResponse } from "./zedExternalProtocol";
import {
  CURSOR_BEARER_TOKEN,
  X_CURSOR_CLIENT_VERSION,
  X_REQUEST_ID,
  X_SESSION_ID,
} from "../src/lib/env";

type ZedPosition = {
  line: number;
  column: number;
};

type ZedRequest = {
  version: number;
  path: string;
  absolute_path?: string;
  workspace_root?: string;
  language?: string;
  contents: string;
  cursor: ZedPosition;
  cursor_request?: Record<string, any>;
  cursorRequest?: Record<string, any>;
};

type CursorResult = {
  status?: number;
  source?: "exact" | "legacy";
  bindingId?: string;
  text: string;
  rangeToReplace?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
  cursorPredictionTarget?: {
    relativePath: string;
    lineNumberOneIndexed: number;
    expectedContent?: string;
    shouldRetriggerCpp?: boolean;
  } | null;
  error?: unknown;
};

type ZedRange = {
  start: ZedPosition;
  end: ZedPosition;
};

const PORT = Number(process.env.ZED_CURSOR_PROXY_PORT ?? "17878");
const DEBUG = process.env.ZED_CURSOR_PROXY_DEBUG === "1";
const CAPTURE = process.env.ZED_CURSOR_PROXY_CAPTURE === "1";
const CAPTURE_DIR =
  process.env.ZED_CURSOR_PROXY_CAPTURE_DIR ?? "captures/zed-cursor-tab";
const previousContentsByPath = new Map<string, string>();
const requestRoot = await protobuf.load("./protobuf/streamCppRequest.proto");
const Request = requestRoot.lookupType("aiserver.v1.StreamCppRequest");
const responseRoot = await protobuf.load("./protobuf/streamCppResponse.proto");
const StreamCppResponse = responseRoot.lookupType("aiserver.v1.StreamCppResponse");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(CAPTURE_DIR, `${day}.jsonl`);
}

function appendCapture(record: Record<string, unknown>) {
  if (!CAPTURE) {
    return;
  }

  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.appendFileSync(captureFilePath(), `${JSON.stringify(record)}\n`);
}

function relativePath(request: ZedRequest): string {
  if (request.workspace_root && request.absolute_path) {
    return path.relative(request.workspace_root, request.absolute_path);
  }
  return request.path;
}

function languageId(language?: string): string {
  return (language ?? "plaintext").toLowerCase().replace(/\s+/g, "");
}

function rememberContents(path: string, contents: string) {
  previousContentsByPath.set(path, contents);
  if (previousContentsByPath.size > 200) {
    const oldest = previousContentsByPath.keys().next().value;
    if (oldest) {
      previousContentsByPath.delete(oldest);
    }
  }
}

function formatDiffHistory(previous: string, current: string): string[] {
  if (previous === current) {
    return [];
  }

  const previousLines = previous.split("\n");
  const currentLines = current.split("\n");
  let start = 0;
  while (
    start < previousLines.length &&
    start < currentLines.length &&
    previousLines[start] === currentLines[start]
  ) {
    start++;
  }

  let previousEnd = previousLines.length;
  let currentEnd = currentLines.length;
  while (
    previousEnd > start &&
    currentEnd > start &&
    previousLines[previousEnd - 1] === currentLines[currentEnd - 1]
  ) {
    previousEnd--;
    currentEnd--;
  }

  const lines: string[] = [];
  for (let index = start; index < Math.min(previousEnd, start + 20); index++) {
    lines.push(`${index + 1}-|${previousLines[index] ?? ""}`);
  }
  for (let index = start; index < Math.min(currentEnd, start + 20); index++) {
    lines.push(`${index + 1}+|${currentLines[index] ?? ""}`);
  }

  return lines.length ? [lines.join("\n")] : [];
}

function buildExactCursorPayload(request: ZedRequest, exactPayload: Record<string, any>) {
  const now = Date.now();
  const relPath = relativePath(request);
  const payload: any = {
    ...structuredClone(defaultStreamCppPayload),
    ...exactPayload,
    currentFile: {
      ...structuredClone(defaultStreamCppPayload.currentFile),
      ...(exactPayload.currentFile ?? {}),
    },
  };

  payload.currentFile.relativeWorkspacePath =
    payload.currentFile.relativeWorkspacePath || relPath;
  payload.currentFile.contents = payload.currentFile.contents ?? request.contents;
  payload.currentFile.cursorPosition =
    payload.currentFile.cursorPosition ?? request.cursor;
  payload.currentFile.languageId =
    payload.currentFile.languageId || languageId(request.language);
  payload.currentFile.totalNumberOfLines =
    payload.currentFile.totalNumberOfLines ||
    request.contents.split(payload.currentFile.lineEnding ?? "\n").length;
  payload.currentFile.workspaceRootPath =
    payload.currentFile.workspaceRootPath ?? request.workspace_root ?? "";
  payload.currentFile.lineEnding =
    payload.currentFile.lineEnding ??
    (request.contents.includes("\r\n") ? "\r\n" : "\n");

  normalizeFileDiffHistories(payload, now);

  payload.modelName = process.env.CURSOR_TAB_MODEL ?? payload.modelName ?? "fast";
  payload.workspaceId = payload.workspaceId ?? request.workspace_root ?? "";
  payload.clientTime = now;
  payload.timeSinceRequestStart = 0;
  payload.timeAtRequestSend = now;
  payload.clientTimezoneOffset = new Date().getTimezoneOffset();
  payload.supportsCpt = process.env.ZED_CURSOR_PROXY_CPT === "1";
  payload.supportsCrlfCpt = process.env.ZED_CURSOR_PROXY_CPT === "1";
  payload.enableMoreContext =
    process.env.ZED_CURSOR_PROXY_MORE_CONTEXT === "1" ||
    Boolean(payload.enableMoreContext);

  return payload;
}

function buildLegacyCursorPayload(request: ZedRequest) {
  const payload = structuredClone(defaultStreamCppPayload);
  const relPath = relativePath(request);
  const now = Date.now();
  const lineEnding = request.contents.includes("\r\n") ? "\r\n" : "\n";
  const diffHistory = formatDiffHistory(
    previousContentsByPath.get(relPath) ?? request.contents,
    request.contents,
  );
  rememberContents(relPath, request.contents);

  payload.currentFile = {
    ...payload.currentFile,
    relativeWorkspacePath: relPath,
    contents: request.contents,
    cursorPosition: {
      line: request.cursor.line,
      column: request.cursor.column,
    },
    languageId: languageId(request.language),
    totalNumberOfLines: request.contents.split(lineEnding).length,
    workspaceRootPath: request.workspace_root ?? "",
    lineEnding,
    fileVersion: Math.floor(now / 1000),
  };
  payload.supportsCpt = process.env.ZED_CURSOR_PROXY_CPT === "1";
  payload.supportsCrlfCpt = process.env.ZED_CURSOR_PROXY_CPT === "1";
  payload.enableMoreContext = process.env.ZED_CURSOR_PROXY_MORE_CONTEXT === "1";
  payload.fileDiffHistories = [
    {
      fileName: relPath,
      diffHistory,
      diffHistoryTimestamps: diffHistory.map(() => now),
    },
  ];
  payload.diffHistory = diffHistory;
  payload.modelName = process.env.CURSOR_TAB_MODEL ?? "fast";
  payload.workspaceId = request.workspace_root ?? "";
  payload.clientTime = now;
  payload.timeSinceRequestStart = 0;
  payload.timeAtRequestSend = now;
  payload.clientTimezoneOffset = new Date().getTimezoneOffset();

  return payload;
}

function buildCursorPayload(request: ZedRequest) {
  const exactPayload = request.cursorRequest ?? request.cursor_request;
  if (exactPayload) {
    return buildExactCursorPayload(request, exactPayload);
  }

  return buildLegacyCursorPayload(request);
}

function offsetForPosition(contents: string, position: ZedPosition): number {
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

function positionForOffset(contents: string, targetOffset: number): ZedPosition {
  const offset = Math.max(0, Math.min(targetOffset, contents.length));
  let currentOffset = 0;
  let line = 0;

  for (const segment of contents.split("\n")) {
    const lineEnd = currentOffset + segment.length;
    if (offset <= lineEnd) {
      return { line, column: offset - currentOffset };
    }
    currentOffset = lineEnd + 1;
    line++;
  }

  return { line: Math.max(0, line - 1), column: 0 };
}

function endOffsetForLine(contents: string, targetLine: number): number {
  let offset = 0;
  let line = 0;

  for (const segment of contents.split("\n")) {
    const lineEnd = offset + segment.length;
    if (line === targetLine) {
      return lineEnd;
    }
    offset = lineEnd + 1;
    line++;
  }

  return contents.length;
}

function startOffsetForLine(contents: string, targetLine: number): number {
  let offset = 0;
  let line = 0;

  for (const segment of contents.split("\n")) {
    if (line === targetLine) {
      return offset;
    }
    offset += segment.length + 1;
    line++;
  }

  return contents.length;
}

function comparePositions(left: ZedPosition, right: ZedPosition): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.column - right.column;
}

function isValidRange(range: ZedRange): boolean {
  return comparePositions(range.start, range.end) <= 0;
}

function minimalDocumentEdit(oldContents: string, newContents: string) {
  let prefixLength = 0;
  while (
    prefixLength < oldContents.length &&
    prefixLength < newContents.length &&
    oldContents[prefixLength] === newContents[prefixLength]
  ) {
    prefixLength++;
  }

  let oldSuffixStart = oldContents.length;
  let newSuffixStart = newContents.length;
  while (
    oldSuffixStart > prefixLength &&
    newSuffixStart > prefixLength &&
    oldContents[oldSuffixStart - 1] === newContents[newSuffixStart - 1]
  ) {
    oldSuffixStart--;
    newSuffixStart--;
  }

  return {
    range: {
      start: positionForOffset(oldContents, prefixLength),
      end: positionForOffset(oldContents, oldSuffixStart),
    },
    text: newContents.slice(prefixLength, newSuffixStart),
  };
}

function minimalPrefixEdit(
  oldContents: string,
  oldPrefixEndOffset: number,
  newPrefix: string,
) {
  const oldPrefix = oldContents.slice(0, oldPrefixEndOffset);
  let prefixLength = 0;
  while (
    prefixLength < oldPrefix.length &&
    prefixLength < newPrefix.length &&
    oldPrefix[prefixLength] === newPrefix[prefixLength]
  ) {
    prefixLength++;
  }

  let oldSuffixStart = oldPrefix.length;
  let newSuffixStart = newPrefix.length;
  while (
    oldSuffixStart > prefixLength &&
    newSuffixStart > prefixLength &&
    oldPrefix[oldSuffixStart - 1] === newPrefix[newSuffixStart - 1]
  ) {
    oldSuffixStart--;
    newSuffixStart--;
  }

  return {
    range: {
      start: positionForOffset(oldContents, prefixLength),
      end: positionForOffset(oldContents, oldSuffixStart),
    },
    text: newPrefix.slice(prefixLength, newSuffixStart),
  };
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function commonPrefixLength(left: string, right: string): number {
  let prefixLength = 0;
  while (
    prefixLength < left.length &&
    prefixLength < right.length &&
    left[prefixLength] === right[prefixLength]
  ) {
    prefixLength++;
  }
  return prefixLength;
}

function sameText(left: string, right: string): boolean {
  return left.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n");
}

function isLineBoundary(text: string, offset: number): boolean {
  return (
    offset === 0 ||
    offset === text.length ||
    text[offset - 1] === "\n" ||
    text[offset] === "\n"
  );
}

function trimExistingPrefixOverlap(text: string, existingPrefix: string): string {
  const maxOverlap = Math.min(text.length, existingPrefix.length);

  for (let overlap = maxOverlap; overlap >= 8; overlap--) {
    if (!isLineBoundary(text, overlap)) {
      continue;
    }
    if (existingPrefix.endsWith(text.slice(0, overlap))) {
      return text.slice(overlap);
    }
  }

  return text;
}

function mergeWithExistingSuffix(text: string, existingSuffix: string): string {
  const maxOverlap = Math.min(text.length, existingSuffix.length);

  for (let overlap = maxOverlap; overlap >= 8; overlap--) {
    if (!isLineBoundary(existingSuffix, overlap)) {
      continue;
    }
    if (text.endsWith(existingSuffix.slice(0, overlap))) {
      return text + existingSuffix.slice(overlap);
    }
  }

  return text + existingSuffix;
}

function collapseNearbyDuplicateLines(text: string): string {
  const hasTrailingNewline = text.endsWith("\n");
  const lines = text.replace(/\n$/, "").split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.length > 0) {
      const next = lines[index + 1]?.trim();
      const afterBlank = lines[index + 2]?.trim();
      if (next === trimmed) {
        output.push(line);
        index += 1;
        continue;
      }
      if (lines[index + 1]?.trim() === "" && afterBlank === trimmed) {
        output.push(line);
        index += 2;
        continue;
      }
    }

    output.push(line);
  }

  return output.join("\n") + (hasTrailingNewline ? "\n" : "");
}

function leadingDeclarationNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n").slice(0, 10)) {
    const match = line.match(
      /^\s*(?:export\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/,
    );
    if (match) {
      names.add(match[1]);
    }
  }
  return names;
}

function suffixContainsDeclaration(suffix: string, names: Set<string>): boolean {
  if (names.size === 0) {
    return false;
  }

  for (const line of suffix.split("\n").slice(0, 40)) {
    const match = line.match(
      /^\s*(?:export\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/,
    );
    if (match && names.has(match[1])) {
      return true;
    }
  }

  return false;
}

function currentLineReplacementEdit(
  request: ZedRequest,
  prefixBeforeLine: string,
  suffixAfterLine: string,
  text: string,
) {
  const replacementText = collapseNearbyDuplicateLines(
    trimExistingPrefixOverlap(text, prefixBeforeLine),
  );
  if (
    suffixContainsDeclaration(
      suffixAfterLine,
      leadingDeclarationNames(replacementText),
    )
  ) {
    return null;
  }
  const newContents =
    prefixBeforeLine + mergeWithExistingSuffix(replacementText, suffixAfterLine);
  if (sameText(request.contents, newContents)) {
    return null;
  }
  return minimalDocumentEdit(request.contents, newContents);
}

function editForCursorResult(request: ZedRequest, result: CursorResult) {
  const cursorOffset = offsetForPosition(request.contents, request.cursor);
  const prefixAtCursor = request.contents.slice(0, cursorOffset);
  const suffixAtCursor = request.contents.slice(cursorOffset);
  const sharedPrefixLength = commonPrefixLength(request.contents, result.text);
  const lineStartOffset = startOffsetForLine(request.contents, request.cursor.line);
  const lineEndOffset = endOffsetForLine(request.contents, request.cursor.line);
  const prefixBeforeLine = request.contents.slice(0, lineStartOffset);
  const suffixAfterLine = request.contents.slice(lineEndOffset);
  const currentLinePrefix = request.contents.slice(lineStartOffset, cursorOffset);
  const textWithoutLeadingBlankLines = result.text.replace(/^\n+/, "");

  if (result.text.startsWith(prefixAtCursor)) {
    return minimalDocumentEdit(request.contents, result.text);
  }

  if (result.text.endsWith(suffixAtCursor) && suffixAtCursor.length > 0) {
    return minimalDocumentEdit(request.contents, prefixAtCursor + result.text);
  }

  if (
    result.text.includes("\n") &&
    sharedPrefixLength >= Math.min(24, Math.max(1, cursorOffset))
  ) {
    return minimalPrefixEdit(
      request.contents,
      Math.max(cursorOffset, endOffsetForLine(request.contents, request.cursor.line)),
      result.text,
    );
  }

  if (
    result.text.includes("\n") &&
    textWithoutLeadingBlankLines.startsWith(currentLinePrefix) &&
    (currentLinePrefix.trim().length > 0 || currentLinePrefix.length > 0)
  ) {
    return currentLineReplacementEdit(
      request,
      prefixBeforeLine,
      suffixAfterLine,
      textWithoutLeadingBlankLines,
    );
  }

  if (
    result.text.includes("\n") &&
    currentLinePrefix.trim().length === 0 &&
    textWithoutLeadingBlankLines.trim().length > 0
  ) {
    return currentLineReplacementEdit(
      request,
      prefixBeforeLine,
      suffixAfterLine,
      textWithoutLeadingBlankLines,
    );
  }

  const cursorRange = { start: request.cursor, end: request.cursor };
  const resultLineCount = lineCount(result.text);

  if (resultLineCount > 1 && sharedPrefixLength < Math.min(24, cursorOffset)) {
    if (DEBUG) {
      console.error(
        JSON.stringify({
          dropped: "detached-multiline",
          path: relativePath(request),
          cursor: request.cursor,
          resultLineCount,
          sharedPrefixLength,
          textPreview: result.text.slice(0, 220),
        }),
      );
    }
    return null;
  }

  if (!result.rangeToReplace) {
    return { range: cursorRange, text: result.text };
  }

  const range = {
    start: {
      line: result.rangeToReplace.startLine,
      column: result.rangeToReplace.startColumn,
    },
    end: {
      line: result.rangeToReplace.endLine,
      column: result.rangeToReplace.endColumn,
    },
  };

  if (!isValidRange(range)) {
    if (DEBUG) {
      console.error(
        JSON.stringify({
          dropped:
            resultLineCount > 1 ? "invalid-range-multiline" : "invalid-range",
          path: relativePath(request),
          cursor: request.cursor,
          range,
          resultLineCount,
          sharedPrefixLength,
          textPreview: result.text.slice(0, 220),
        }),
      );
    }
    return resultLineCount > 1 ? null : { range: cursorRange, text: result.text };
  }

  return { range, text: result.text };
}

async function streamCppPayload(
  request: ZedRequest,
  payload: Record<string, any>,
  source: "exact" | "legacy",
): Promise<CursorResult> {
  const token = CURSOR_BEARER_TOKEN;
  if (!token) {
    throw new Error("Missing CURSOR_BEARER_TOKEN in cursor-unchained/.env");
  }

  const protoBuffer = Buffer.from(
    Request.encode(Request.create(payload)).finish(),
  );
  const envelope = Buffer.alloc(5 + protoBuffer.length);
  envelope.writeUInt8(0, 0);
  envelope.writeUInt32BE(protoBuffer.length, 1);
  protoBuffer.copy(envelope, 5);

  const requestId = X_REQUEST_ID || crypto.randomUUID();
  const options: https.RequestOptions = {
    hostname: "us-only.gcpp.cursor.sh",
    port: 443,
    path: "/aiserver.v1.AiService/StreamCpp",
    method: "POST",
    headers: {
      "connect-accept-encoding": "gzip",
      "connect-content-encoding": "gzip",
      "connect-protocol-version": "1",
      "content-type": "application/connect+proto",
      "x-cursor-client-type": "ide",
      "x-cursor-client-version": X_CURSOR_CLIENT_VERSION,
      "x-cursor-streaming": "true",
      "x-request-id": requestId,
      "x-session-id": X_SESSION_ID,
      authorization: `Bearer ${token}`,
      "content-length": envelope.length,
    },
  };

  return await new Promise((resolve, reject) => {
    const req = https.request(options, (res: IncomingMessage) => {
      let dataBuffer = Buffer.alloc(0);
      let settled = false;
      const result: CursorResult = {
        status: res.statusCode,
        source,
        text: "",
        rangeToReplace: null,
        cursorPredictionTarget: null,
      };

      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
        res.destroy();
      };

      res.on("data", (chunk: Buffer) => {
        if (settled) {
          return;
        }
        dataBuffer = Buffer.concat([dataBuffer, chunk]);

        while (dataBuffer.length >= 5) {
          const flags = dataBuffer.readUInt8(0);
          const msgLen = dataBuffer.readUInt32BE(1);

          if (dataBuffer.length < 5 + msgLen) {
            break;
          }

          const msgData = dataBuffer.subarray(5, 5 + msgLen);
          dataBuffer = dataBuffer.subarray(5 + msgLen);

          if (flags & 0x02) {
            continue;
          }

          const decoded = StreamCppResponse.decode(msgData) as any;
          const range = decoded.range_to_replace ?? decoded.rangeToReplace;
          const target =
            decoded.cursor_prediction_target ?? decoded.cursorPredictionTarget;
          const bindingId = decoded.binding_id ?? decoded.bindingId;

          if (decoded.text) {
            result.text += decoded.text;
          }
          if (bindingId) {
            result.bindingId = bindingId;
          }
          if (range) {
            const nextRange = {
              startLine: range.start_line ?? range.startLine ?? 0,
              startColumn: range.start_column ?? range.startColumn ?? 0,
              endLine: range.end_line ?? range.endLine ?? 0,
              endColumn: range.end_column ?? range.endColumn ?? 0,
            };
            const zedRange = {
              start: {
                line: nextRange.startLine,
                column: nextRange.startColumn,
              },
              end: {
                line: nextRange.endLine,
                column: nextRange.endColumn,
              },
            };
            if (DEBUG) {
              console.error(JSON.stringify({ frameRange: nextRange }));
            }
            if (isValidRange(zedRange)) {
              result.rangeToReplace = nextRange;
            }
          }
          if (target) {
            result.cursorPredictionTarget = {
              relativePath: target.relative_path ?? target.relativePath ?? "",
              lineNumberOneIndexed:
                target.line_number_one_indexed ??
                target.lineNumberOneIndexed ??
                1,
              expectedContent:
                target.expected_content ?? target.expectedContent ?? "",
              shouldRetriggerCpp:
                target.should_retrigger_cpp ?? target.shouldRetriggerCpp,
            };
          }
          if (
            (decoded.done_edit || decoded.doneEdit || decoded.done_stream || decoded.doneStream) &&
            (result.text || result.cursorPredictionTarget)
          ) {
            resolveOnce();
            return;
          }
        }
      });

      res.on("end", () => {
        if (settled) {
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Cursor StreamCpp failed with HTTP ${res.statusCode}`));
        } else {
          resolveOnce();
        }
      });

      res.on("error", (error) => {
        if (!settled) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.write(envelope);
    req.end();
  });
}

async function streamCpp(request: ZedRequest): Promise<CursorResult> {
  const exactPayload = request.cursorRequest ?? request.cursor_request;
  const exactResult = await streamCppPayload(
    request,
    buildCursorPayload(request),
    exactPayload ? "exact" : "legacy",
  );

  if (
    exactPayload &&
    exactResult.status &&
    exactResult.status < 400 &&
    (!exactResult.text || sameText(request.contents, exactResult.text)) &&
    !exactResult.cursorPredictionTarget
  ) {
    if (DEBUG) {
      console.error(
        JSON.stringify({
          retrying: "legacy-after-empty-exact",
          path: relativePath(request),
          cursor: request.cursor,
        }),
      );
    }
    return streamCppPayload(request, buildLegacyCursorPayload(request), "legacy");
  }

  return exactResult;
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/accept") {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      appendCapture({
        schema: 1,
        capturedAt: new Date().toISOString(),
        type: "accept",
        id: body.id,
      });
      if (DEBUG) {
        console.error(JSON.stringify({ accepted: body.id ? "prediction" : "missing-id" }));
      }
      return json({ ok: true });
    }

    if (req.method !== "POST" || url.pathname !== "/predict") {
      return json({ error: "not found" }, 404);
    }

    try {
      const zedRequest = (await req.json()) as ZedRequest;
      const startedAt = performance.now();
      const cursorResult = await streamCpp(zedRequest);
      const zedResponse = toZedResponse(zedRequest, cursorResult, {
        debug: DEBUG,
        debugPath: relativePath(zedRequest),
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      appendCapture({
        schema: 1,
        capturedAt: new Date().toISOString(),
        latencyMs,
        relativePath: relativePath(zedRequest),
        language: zedRequest.language,
        cursor: zedRequest.cursor,
        request: zedRequest,
        cursorResult,
        zedResponse,
      });
      return json(zedResponse);
    } catch (error) {
      console.error(error);
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
});

console.log(`Zed Cursor proxy listening on http://127.0.0.1:${PORT}/predict`);
