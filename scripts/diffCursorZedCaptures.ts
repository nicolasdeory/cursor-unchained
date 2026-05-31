import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import protobuf from "protobufjs";

type JsonRecord = Record<string, any>;

type SemanticSummary = {
  source: "cursor" | "zed";
  capturedAt?: string;
  path?: string;
  cursor?: unknown;
  currentFile?: {
    path?: string;
    languageId?: string;
    totalNumberOfLines?: number;
    fileVersion?: unknown;
    relyOnFilesync?: unknown;
    sha256Hash?: string;
    contents?: ContentSummary;
  };
  request?: {
    modelName?: unknown;
    supportsCpt?: unknown;
    supportsCrlfCpt?: unknown;
    enableMoreContext?: unknown;
    workspaceId?: unknown;
    counts: Record<string, number>;
  };
  latency?: Record<string, number>;
};

type ContentSummary = {
  length: number;
  lines: number;
  sha256: string;
};

const COUNT_FIELDS = [
  "diffHistory",
  "contextItems",
  "diffHistoryKeys",
  "fileDiffHistories",
  "mergedDiffHistories",
  "blockDiffPatches",
  "parameterHints",
  "lspContexts",
  "additionalFiles",
  "filesyncUpdates",
  "codeResults",
  "lspSuggestedItems",
  "linterErrors",
];

const streamCppRequestRoot = protobuf.loadSync(
  path.join(import.meta.dir, "../protobuf/streamCppRequest.proto"),
);
const StreamCppRequest = streamCppRequestRoot.lookupType("aiserver.v1.StreamCppRequest");

function sha256(text: string) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function contentSummary(contents: unknown): ContentSummary | undefined {
  if (typeof contents !== "string") {
    return undefined;
  }
  return {
    length: contents.length,
    lines: contents.length ? contents.split(/\r\n|\n/).length : 0,
    sha256: sha256(contents),
  };
}

function readJsonl(filePath: string) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as JsonRecord;
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: invalid JSONL: ${String(error)}`);
      }
    });
}

function latestJsonl(dir: string) {
  if (!fs.existsSync(dir)) {
    return undefined;
  }
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort()
    .map((entry) => path.join(dir, entry))
    .at(-1);
}

function cursorMessage(record: JsonRecord) {
  if (
    record.typeName === "aiserver.v1.StreamCppRequest" &&
    record.direction === "encode" &&
    record.message
  ) {
    return record.message;
  }
  if (
    record.typeName === "aiserver.v1.StreamCppRequest" &&
    typeof record.requestBodyBase64 === "string"
  ) {
    return decodeStreamCppRequest(record.requestBodyBase64);
  }
  return undefined;
}

function stripConnectEnvelope(bytes: Uint8Array) {
  if (bytes.length < 5 || (bytes[0] !== 0 && bytes[0] !== 1)) {
    return bytes;
  }
  const length =
    (bytes[1] << 24) |
    (bytes[2] << 16) |
    (bytes[3] << 8) |
    bytes[4];
  return length === bytes.length - 5 ? bytes.subarray(5) : bytes;
}

export function decodeStreamCppRequest(base64: string) {
  const bytes = stripConnectEnvelope(Buffer.from(base64, "base64"));
  const decoded = StreamCppRequest.decode(bytes);
  return StreamCppRequest.toObject(decoded, {
    defaults: false,
    longs: String,
    enums: String,
    bytes: String,
  }) as JsonRecord;
}

function zedMessage(record: JsonRecord) {
  if (record.type && record.type !== "stream-cpp-request") {
    return undefined;
  }
  if (!record.type && record.latencyMs !== undefined) {
    return undefined;
  }
  return (
    record.cursorPayload ??
    record.request?.cursorPayload ??
    record.request?.cursorRequest ??
    record.request?.cursor_request ??
    undefined
  );
}

function count(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === "object" && Array.isArray((value as JsonRecord).suggestions)) {
    return (value as JsonRecord).suggestions.length;
  }
  if (value && typeof value === "object" && Array.isArray((value as JsonRecord).errors)) {
    return (value as JsonRecord).errors.length;
  }
  if (value && typeof value === "object") {
    return 1;
  }
  return 0;
}

export function summarizeCapture(source: "cursor" | "zed", record: JsonRecord): SemanticSummary | undefined {
  const message = source === "cursor" ? cursorMessage(record) : zedMessage(record);
  if (!message) {
    return undefined;
  }
  const currentFile = message.currentFile ?? message.current_file ?? {};
  const counts: Record<string, number> = {};
  for (const field of COUNT_FIELDS) {
    counts[field] = count(message[field] ?? currentFile[field]);
  }

  return {
    source,
    capturedAt: record.capturedAt,
    path: record.relativePath ?? currentFile.relativeWorkspacePath ?? currentFile.relative_workspace_path,
    cursor: currentFile.cursorPosition ?? currentFile.cursor_position ?? record.cursor,
    currentFile: {
      path: currentFile.relativeWorkspacePath ?? currentFile.relative_workspace_path,
      languageId: currentFile.languageId ?? currentFile.language_id,
      totalNumberOfLines:
        currentFile.totalNumberOfLines ?? currentFile.total_number_of_lines,
      fileVersion: currentFile.fileVersion ?? currentFile.file_version,
      relyOnFilesync: currentFile.relyOnFilesync ?? currentFile.rely_on_filesync,
      sha256Hash: currentFile.sha256Hash ?? currentFile.sha_256_hash,
      contents: contentSummary(currentFile.contents),
    },
    request: {
      modelName: message.modelName ?? message.model_name,
      supportsCpt: message.supportsCpt ?? message.supports_cpt,
      supportsCrlfCpt: message.supportsCrlfCpt ?? message.supports_crlf_cpt,
      enableMoreContext: message.enableMoreContext ?? message.enable_more_context,
      workspaceId: message.workspaceId ?? message.workspace_id,
      counts,
    },
    latency: {
      totalMs: record.latencyMs ?? record.durationMs,
      networkMs: record.networkMs,
      requestBuildMs: record.requestBuildMs,
      responseDecodeMs: record.responseDecodeMs,
      normalizationMs: record.normalizationMs,
    },
  };
}

function flatten(value: unknown, prefix = ""): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { [prefix]: value };
  }
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    Object.assign(output, flatten(nested, prefix ? `${prefix}.${key}` : key));
  }
  return output;
}

export function semanticDiff(cursor: SemanticSummary, zed: SemanticSummary) {
  const cursorFlat = flatten(cursor);
  const zedFlat = flatten(zed);
  const keys = [...new Set([...Object.keys(cursorFlat), ...Object.keys(zedFlat)])]
    .filter((key) => key !== "source")
    .sort();
  return keys
    .filter((key) => JSON.stringify(cursorFlat[key]) !== JSON.stringify(zedFlat[key]))
    .map((key) => ({
      field: key,
      cursor: cursorFlat[key],
      zed: zedFlat[key],
    }));
}

export function summarizeFiles(cursorFile: string, zedFile: string) {
  const cursor = readJsonl(cursorFile)
    .map((record) => summarizeCapture("cursor", record))
    .findLast(Boolean);
  const zed = readJsonl(zedFile)
    .map((record) => summarizeCapture("zed", record))
    .findLast(Boolean);
  if (!cursor) {
    throw new Error(`No Cursor StreamCppRequest records in ${cursorFile}`);
  }
  if (!zed) {
    throw new Error(`No Zed StreamCpp payload records in ${zedFile}`);
  }
  return { cursor, zed, diff: semanticDiff(cursor, zed) };
}

if (import.meta.main) {
  const cursorFile = Bun.argv[2] ?? latestJsonl("captures/cursor-runtime");
  const zedFile = Bun.argv[3] ?? latestJsonl("captures/zed-cursor-tab");
  if (!cursorFile || !zedFile) {
    console.error("Usage: bun run scripts/diffCursorZedCaptures.ts [cursor.jsonl] [zed.jsonl]");
    process.exit(1);
  }
  console.log(JSON.stringify(summarizeFiles(cursorFile, zedFile), null, 2));
}
