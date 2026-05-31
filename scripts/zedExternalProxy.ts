import protobuf from "protobufjs";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { defaultStreamCppPayload } from "../src/lib/constants";
import {
  normalizeFileDiffHistories,
  refreshTabContextPayloadFromStream,
} from "./cursorPayloadUtils";
import {
  extensionForPath,
  recordCppAcceptFate,
  recordCppPartialAcceptFate,
  recordCppRejectFate,
  type PredictionAcceptMetadata,
} from "./cursorAcceptTelemetry";
import { toZedResponse } from "./zedExternalProtocol";
import {
  TabContextCache,
  tabContextCacheInput as makeTabContextCacheInput,
} from "./tabContextCache";
import {
  CURSOR_BEARER_TOKEN,
  X_CURSOR_CLIENT_VERSION,
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
  requestId?: string;
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
const SUPPORTS_CPT = process.env.ZED_CURSOR_PROXY_CPT !== "0";
const ACCEPT_TELEMETRY = process.env.ZED_CURSOR_PROXY_ACCEPT_TELEMETRY !== "0";
const previousContentsByPath = new Map<string, string>();
const fileVersionsByPath = new Map<
  string,
  {
    hash: string;
    version: number;
  }
>();
const acceptMetadataByPredictionId = new Map<string, PredictionAcceptMetadata>();
const requestRoot = await protobuf.load("./protobuf/streamCppRequest.proto");
const Request = requestRoot.lookupType("aiserver.v1.StreamCppRequest");
const responseRoot = await protobuf.load("./protobuf/streamCppResponse.proto");
const StreamCppResponse = responseRoot.lookupType("aiserver.v1.StreamCppResponse");
const cppConfigRoot = await protobuf.load("./protobuf/cppConfig.proto");
const CppConfigRequest = cppConfigRoot.lookupType("aiserver.v1.CppConfigRequest");
const CppConfigResponse = cppConfigRoot.lookupType("aiserver.v1.CppConfigResponse");
const refreshTabContextRoot = await protobuf.load(
  "./protobuf/refreshTabContextRequest.proto",
);
const RefreshTabContextRequest = refreshTabContextRoot.lookupType(
  "aiserver.v1.RefreshTabContextRequest",
);
const refreshTabContextResponseRoot = await protobuf.load(
  "./protobuf/refreshTabContextResponse.proto",
);
const RefreshTabContextResponse = refreshTabContextResponseRoot.lookupType(
  "aiserver.v1.RefreshTabContextResponse",
);

type CursorCppConfig = {
  cppUrl?: string;
  geoCppBackendUrl?: string;
  globalDebounceDurationMillis?: number;
  clientDebounceDurationMillis?: number;
  supportsCpt?: boolean;
  supportsCrlfCpt?: boolean;
  isFusedCursorPredictionModel?: boolean;
  allowsTabChunks?: boolean;
  suggestionHintConfig?: {
    enabledForPathExtensions?: string[];
    importantLspExtensions?: string[];
  };
};

let cachedCppConfig:
  | {
      fetchedAt: number;
      config: CursorCppConfig | null;
      error?: string;
    }
  | undefined;
let inFlightCppConfigFetch: Promise<CursorCppConfig | null> | undefined;
const cachedTabContexts = new TabContextCache();
const inFlightTabContextRefreshes = new Set<string>();
const cachedCursorWorkspaceIds = new Map<string, string | null>();
const cachedCursorWorkspaceStates = new Map<string, CursorWorkspaceState | null>();

type CursorWorkspaceState = {
  storageId?: string;
  uniqueCppWorkspaceId?: string;
  repoName?: string;
  repoOwner?: string;
  orthogonalTransformSeed?: number;
  pathEncryptionKey?: string;
  preferredEmbeddingModel?: number;
  numFiles?: number;
};

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

function connectEnvelope(protoBuffer: Buffer) {
  const envelope = Buffer.alloc(5 + protoBuffer.length);
  envelope.writeUInt8(0, 0);
  envelope.writeUInt32BE(protoBuffer.length, 1);
  protoBuffer.copy(envelope, 5);
  return envelope;
}

function maybeStripConnectEnvelope(buffer: Buffer) {
  if (buffer.length >= 5) {
    const msgLen = buffer.readUInt32BE(1);
    if (buffer.length === 5 + msgLen) {
      const message = buffer.subarray(5);
      if ((buffer.readUInt8(0) & 0x01) === 0x01) {
        return gunzipSync(message);
      }
      return message;
    }
  }
  return buffer;
}

function maybeDecompressHttpBody(buffer: Buffer, headers: IncomingMessage["headers"]) {
  const encoding = String(headers["content-encoding"] ?? "").toLowerCase();
  if (encoding.includes("gzip") || (buffer[0] === 0x1f && buffer[1] === 0x8b)) {
    return gunzipSync(buffer);
  }
  return buffer;
}

function decodeCppConfig(buffer: Buffer): CursorCppConfig {
  const decoded = CppConfigResponse.toObject(
    CppConfigResponse.decode(maybeStripConnectEnvelope(buffer)),
    { defaults: false },
  ) as CursorCppConfig;
  return decoded;
}

function cursorHeaders(bodyLength: number, requestId = crypto.randomUUID()) {
  const token = CURSOR_BEARER_TOKEN;
  if (!token) {
    throw new Error("Missing CURSOR_BEARER_TOKEN in cursor-unchained/.env");
  }
  return {
    "connect-accept-encoding": "gzip",
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    "x-cursor-client-type": "ide",
    "x-cursor-client-version": X_CURSOR_CLIENT_VERSION,
    "x-request-id": requestId,
    "x-session-id": X_SESSION_ID,
    authorization: `Bearer ${token}`,
    "content-length": bodyLength,
  };
}

function cursorConfigEndpoint() {
  const raw =
    process.env.CURSOR_CPP_CONFIG_URL ??
    "https://api4.cursor.sh/aiserver.v1.AiService/CppConfig";
  return new URL(raw);
}

function streamCppEndpoint(config: CursorCppConfig | null) {
  const raw =
    process.env.CURSOR_STREAM_CPP_URL ??
    config?.geoCppBackendUrl ??
    config?.cppUrl ??
    "https://us-only.gcpp.cursor.sh:443/aiserver.v1.AiService/StreamCpp";
  const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/aiserver.v1.AiService/StreamCpp";
  }
  return url;
}

function refreshTabContextEndpoint(config: CursorCppConfig | null) {
  const raw =
    process.env.CURSOR_REFRESH_TAB_CONTEXT_URL ??
    "https://api2.cursor.sh/aiserver.v1.AiService/RefreshTabContext";
  const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/aiserver.v1.AiService/RefreshTabContext";
  } else {
    url.pathname = url.pathname.replace(/\/StreamCpp$/, "/RefreshTabContext");
  }
  return url;
}

async function fetchCppConfig() {
  const ttlMs = Number(process.env.ZED_CURSOR_PROXY_CPP_CONFIG_TTL_MS ?? "600000");
  const now = Date.now();
  if (cachedCppConfig && now - cachedCppConfig.fetchedAt < ttlMs) {
    return cachedCppConfig.config;
  }

  try {
    const body = Buffer.from(
      CppConfigRequest.encode(
        CppConfigRequest.create({
          model: process.env.CURSOR_TAB_MODEL ?? "fast",
          supportsCpt: SUPPORTS_CPT,
        }),
      ).finish(),
    );
    const endpoint = cursorConfigEndpoint();
    const requestId = crypto.randomUUID();
    const config = await new Promise<CursorCppConfig>((resolve, reject) => {
      const req = https.request(
        {
          hostname: endpoint.hostname,
          port: Number(endpoint.port || 443),
          path: `${endpoint.pathname}${endpoint.search}`,
          method: "POST",
          headers: {
            ...cursorHeaders(body.length, requestId),
            "content-type": "application/proto",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            const responseBody = maybeDecompressHttpBody(Buffer.concat(chunks), res.headers);
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                new Error(
                  `Cursor CppConfig failed with HTTP ${res.statusCode}: ${responseBody
                    .toString("utf8")
                    .slice(0, 500)}`,
                ),
              );
              return;
            }
            try {
              resolve(decodeCppConfig(responseBody));
            } catch (error) {
              reject(error);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
    cachedCppConfig = { fetchedAt: now, config };
    appendCapture({
      schema: 1,
      capturedAt: new Date().toISOString(),
      type: "cpp-config",
      requestId,
      endpoint: endpoint.toString(),
      config,
    });
    return config;
  } catch (error) {
    cachedCppConfig = {
      fetchedAt: now,
      config: null,
      error: error instanceof Error ? error.message : String(error),
    };
    if (DEBUG) {
      console.error(JSON.stringify({ cppConfigError: cachedCppConfig.error }));
    }
    return null;
  }
}

function cppConfigFast() {
  const ttlMs = Number(process.env.ZED_CURSOR_PROXY_CPP_CONFIG_TTL_MS ?? "600000");
  const now = Date.now();
  if (cachedCppConfig && now - cachedCppConfig.fetchedAt < ttlMs) {
    return cachedCppConfig.config;
  }

  inFlightCppConfigFetch ??= fetchCppConfig().finally(() => {
    inFlightCppConfigFetch = undefined;
  });
  return cachedCppConfig?.config ?? null;
}

function relativePath(request: ZedRequest): string {
  if (request.workspace_root && request.absolute_path) {
    return path.relative(request.workspace_root, request.absolute_path);
  }
  return request.path;
}

function absolutePath(request: ZedRequest): string | undefined {
  if (request.absolute_path) {
    return request.absolute_path;
  }
  if (request.workspace_root && request.path && !path.isAbsolute(request.path)) {
    return path.join(request.workspace_root, request.path);
  }
  if (request.path && path.isAbsolute(request.path)) {
    return request.path;
  }
  return undefined;
}

function pathExists(filePath: string) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function gitOutput(cwd: string, args: string[]) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function normalizeFsPath(filePath: string) {
  const withoutFileUri = filePath.startsWith("file://")
    ? decodeURIComponent(new URL(filePath).pathname)
    : filePath;
  try {
    return fs.realpathSync(withoutFileUri);
  } catch {
    return path.resolve(withoutFileUri);
  }
}

function isPathInWorkspace(filePath: string, workspaceRoot: string) {
  const normalizedPath = normalizeFsPath(filePath);
  const normalizedRoot = normalizeFsPath(workspaceRoot);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

function cursorUserDir() {
  return path.join(
    process.env.HOME ?? "",
    "Library",
    "Application Support",
    "Cursor",
    "User",
  );
}

function cursorWorkspaceIdFromWorkspaceStorage(workspaceRoot: string) {
  const workspaceStorageDir = path.join(cursorUserDir(), "workspaceStorage");
  if (!pathExists(workspaceStorageDir)) {
    return null;
  }

  for (const entry of fs.readdirSync(workspaceStorageDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const workspaceJsonPath = path.join(workspaceStorageDir, entry.name, "workspace.json");
    if (!pathExists(workspaceJsonPath)) {
      continue;
    }

    try {
      const workspaceJson = JSON.parse(fs.readFileSync(workspaceJsonPath, "utf8")) as {
        folder?: string;
        workspace?: { folders?: { uri?: string; path?: string }[] };
      };
      const folderUris = [
        workspaceJson.folder,
        ...(workspaceJson.workspace?.folders ?? []).flatMap((folder) => [
          folder.uri,
          folder.path,
        ]),
      ].filter((uri): uri is string => Boolean(uri));
      if (folderUris.some((uri) => isPathInWorkspace(uri, workspaceRoot))) {
        return entry.name;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function metadataMentionsWorkspace(value: unknown, workspaceRoot: string): boolean {
  if (typeof value === "string") {
    if (!value.startsWith("/") && !value.startsWith("file://")) {
      return false;
    }
    try {
      return isPathInWorkspace(value, workspaceRoot);
    } catch {
      return false;
    }
  }

  if (Array.isArray(value)) {
    return value.some((item) => metadataMentionsWorkspace(item, workspaceRoot));
  }

  if (value && typeof value === "object") {
    return Object.values(value).some((item) =>
      metadataMentionsWorkspace(item, workspaceRoot),
    );
  }

  return false;
}

function cursorWorkspaceIdFromRetrievalCheckpoints(workspaceRoot: string) {
  const checkpointsDir = path.join(
    cursorUserDir(),
    "globalStorage",
    "anysphere.cursor-retrieval",
    "checkpoints",
  );
  if (!pathExists(checkpointsDir)) {
    return null;
  }

  let best: { workspaceId: string; startedAt: number } | null = null;
  for (const entry of fs.readdirSync(checkpointsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const metadataPath = path.join(checkpointsDir, entry.name, "metadata.json");
    if (!pathExists(metadataPath)) {
      continue;
    }

    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
        workspaceId?: string;
        startTrackingDateUnixMilliseconds?: number;
      };
      if (!metadata.workspaceId || !metadataMentionsWorkspace(metadata, workspaceRoot)) {
        continue;
      }
      const startedAt = metadata.startTrackingDateUnixMilliseconds ?? 0;
      if (!best || startedAt > best.startedAt) {
        best = { workspaceId: metadata.workspaceId, startedAt };
      }
    } catch {
      continue;
    }
  }

  return best?.workspaceId ?? null;
}

function sqliteWorkspaceValue(storageId: string, key: string) {
  const dbPath = path.join(cursorUserDir(), "workspaceStorage", storageId, "state.vscdb");
  if (!pathExists(dbPath)) {
    return "";
  }

  try {
    return execFileSync(
      "sqlite3",
      [
        dbPath,
        `select value from ItemTable where key='${key.replace(/'/g, "''")}' limit 1;`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return "";
  }
}

function repoKeyStateFromRetrievalStorage(raw: string) {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    const repoKeysEntry = Object.entries(parsed).find(
      ([key, value]) => key.endsWith("/repoKeys") && value && typeof value === "object",
    );
    const indexingStatusEntry = Object.entries(parsed).find(
      ([key, value]) =>
        key.endsWith("/indexingStatus") && value && typeof value === "object",
    );
    const repoKeys = repoKeysEntry?.[1] as
      | {
          repoName?: string;
          orthogonalTransformationSeed?: number;
          pathEncryptionKey?: string;
        }
      | undefined;
    const status = indexingStatusEntry?.[1] as
      | { globalStatus?: { numFiles?: number } }
      | undefined;
    const repoOwner = indexingStatusEntry?.[0].split("/")[2];
    return {
      repoName: repoKeys?.repoName,
      repoOwner,
      orthogonalTransformSeed: repoKeys?.orthogonalTransformationSeed,
      pathEncryptionKey: repoKeys?.pathEncryptionKey,
      numFiles: status?.globalStatus?.numFiles,
    };
  } catch {
    return {};
  }
}

function workspaceUserStateFromStorage(raw: string) {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as {
      uniqueCppWorkspaceId?: string;
      indexingData?: { preferredEmbeddingModel?: number };
    };
    return {
      uniqueCppWorkspaceId: parsed.uniqueCppWorkspaceId,
      preferredEmbeddingModel: parsed.indexingData?.preferredEmbeddingModel,
    };
  } catch {
    return {};
  }
}

function cursorWorkspaceStateForRoot(workspaceRoot?: string): CursorWorkspaceState | null {
  if (!workspaceRoot) {
    return null;
  }

  const normalizedRoot = normalizeFsPath(workspaceRoot);
  if (cachedCursorWorkspaceStates.has(normalizedRoot)) {
    return cachedCursorWorkspaceStates.get(normalizedRoot) ?? null;
  }

  const storageId = cursorWorkspaceIdFromWorkspaceStorage(normalizedRoot) ?? undefined;
  const checkpointWorkspaceId =
    cursorWorkspaceIdFromRetrievalCheckpoints(normalizedRoot) ?? undefined;
  if (!storageId && !checkpointWorkspaceId) {
    cachedCursorWorkspaceStates.set(normalizedRoot, null);
    return null;
  }

  const workspaceUser = storageId
    ? workspaceUserStateFromStorage(
        sqliteWorkspaceValue(
          storageId,
          "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.workspaceUser",
        ),
      )
    : {};
  const repoKeys = storageId
    ? repoKeyStateFromRetrievalStorage(
        sqliteWorkspaceValue(storageId, "anysphere.cursor-retrieval"),
      )
    : {};

  const state: CursorWorkspaceState = {
    storageId: storageId ?? checkpointWorkspaceId,
    uniqueCppWorkspaceId: workspaceUser.uniqueCppWorkspaceId,
    preferredEmbeddingModel: workspaceUser.preferredEmbeddingModel,
    ...repoKeys,
  };
  cachedCursorWorkspaceStates.set(normalizedRoot, state);
  return state;
}

function cursorWorkspaceIdForRoot(workspaceRoot?: string) {
  if (process.env.CURSOR_WORKSPACE_ID) {
    return process.env.CURSOR_WORKSPACE_ID;
  }
  if (!workspaceRoot) {
    return null;
  }

  const normalizedRoot = normalizeFsPath(workspaceRoot);
  if (cachedCursorWorkspaceIds.has(normalizedRoot)) {
    return cachedCursorWorkspaceIds.get(normalizedRoot) ?? null;
  }

  const state = cursorWorkspaceStateForRoot(normalizedRoot);
  const workspaceId = state?.uniqueCppWorkspaceId ?? state?.storageId ?? null;
  cachedCursorWorkspaceIds.set(normalizedRoot, workspaceId);
  return workspaceId;
}

function cursorWorkspaceIdForRequest(request: ZedRequest, payloadWorkspaceId?: unknown) {
  const cursorWorkspaceId = cursorWorkspaceIdForRoot(request.workspace_root);
  if (cursorWorkspaceId) {
    return cursorWorkspaceId;
  }

  if (typeof payloadWorkspaceId === "string" && payloadWorkspaceId.length > 0) {
    return payloadWorkspaceId;
  }

  return request.workspace_root ?? "";
}

function repositoryInfo(request: ZedRequest) {
  const workspaceRoot = request.workspace_root;
  if (!workspaceRoot || !pathExists(path.join(workspaceRoot, ".git"))) {
    return undefined;
  }

  const remotes = gitOutput(workspaceRoot, ["remote"]).split("\n").filter(Boolean);
  const remoteUrls = remotes
    .map((remote) => gitOutput(workspaceRoot, ["remote", "get-url", remote]))
    .filter(Boolean);
  const originUrl =
    remoteUrls.find((url) => url.includes("github.com")) ?? remoteUrls[0] ?? "";
  const match = /github\.com[:/](?<owner>[^/]+)\/(?<name>[^/.]+)(?:\.git)?/.exec(
    originUrl,
  );
  const repoName = match?.groups?.name ?? path.basename(workspaceRoot);
  const repoOwner = match?.groups?.owner ?? "";
  const cursorState = cursorWorkspaceStateForRoot(workspaceRoot);

  const info: Record<string, any> = {
    relativeWorkspacePath: cursorState?.repoName ? "." : relativePath(request),
    remoteUrls,
    remoteNames: remotes,
    repoName: cursorState?.repoName ?? repoName,
    repoOwner: cursorState?.repoOwner ?? repoOwner,
    isTracked: cursorState?.repoName ? false : Boolean(remoteUrls.length),
    isLocal: true,
    workspaceUri: pathToFileURL(workspaceRoot).toString(),
  };
  if (cursorState?.numFiles !== undefined) {
    info.numFiles = cursorState.numFiles;
  }
  if (cursorState?.orthogonalTransformSeed !== undefined) {
    info.orthogonalTransformSeed = cursorState.orthogonalTransformSeed;
  }
  if (cursorState?.preferredEmbeddingModel !== undefined) {
    info.preferredEmbeddingModel = cursorState.preferredEmbeddingModel;
  }
  return info;
}

function languageId(language?: string): string {
  return (language ?? "plaintext").toLowerCase().replace(/\s+/g, "");
}

function stableFileVersion(filePath: string, contents: string) {
  const hash = crypto.createHash("sha256").update(contents).digest("hex");
  const previous = fileVersionsByPath.get(filePath);
  if (previous?.hash === hash) {
    return { hash, version: previous.version };
  }

  const version = Math.max(1, (previous?.version ?? 0) + 1);
  fileVersionsByPath.set(filePath, { hash, version });
  if (fileVersionsByPath.size > 200) {
    const oldest = fileVersionsByPath.keys().next().value;
    if (oldest) {
      fileVersionsByPath.delete(oldest);
    }
  }
  return { hash, version };
}

function cursorCurrentFilePath(request: ZedRequest) {
  if (process.env.ZED_CURSOR_PROXY_CURRENT_FILE_PATH_STYLE === "relative") {
    return relativePath(request);
  }
  return absolutePath(request) ?? relativePath(request);
}

function absolutizeCurrentFileScopedPaths(payload: Record<string, any>, request: ZedRequest) {
  const cursorPath = cursorCurrentFilePath(request);
  const relPath = relativePath(request);
  const currentFile = payload.currentFile ?? {};
  currentFile.relativeWorkspacePath = cursorPath;
  payload.currentFile = currentFile;

  if (payload.linterErrors?.relativeWorkspacePath === relPath) {
    payload.linterErrors.relativeWorkspacePath = cursorPath;
  }

  for (const history of payload.fileDiffHistories ?? []) {
    if (history.fileName === relPath || history.fileName === request.path) {
      history.fileName = cursorPath;
    }
  }
}

function stripNoisyZedContext(payload: Record<string, any>) {
  if (process.env.ZED_CURSOR_PROXY_KEEP_ZED_ADDITIONAL_FILES !== "1") {
    payload.additionalFiles = [];
  }
  if (process.env.ZED_CURSOR_PROXY_KEEP_ZED_CODE_RESULTS !== "1") {
    payload.codeResults = [];
  }
  if (process.env.ZED_CURSOR_PROXY_MORE_CONTEXT !== "1") {
    payload.enableMoreContext = false;
  }
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

function applyCppConfigToPayload(payload: Record<string, any>, config: CursorCppConfig | null) {
  payload.modelName = process.env.CURSOR_TAB_MODEL ?? payload.modelName ?? "fast";
  payload.supportsCpt =
    process.env.ZED_CURSOR_PROXY_CPT === undefined
      ? (config?.supportsCpt ?? SUPPORTS_CPT)
      : SUPPORTS_CPT;
  payload.supportsCrlfCpt =
    process.env.ZED_CURSOR_PROXY_CPT === undefined
      ? (config?.supportsCrlfCpt ?? payload.supportsCpt)
      : SUPPORTS_CPT;
  if (config?.allowsTabChunks !== undefined) {
    payload.allowsTabChunks = config.allowsTabChunks;
  }
  if (config?.isFusedCursorPredictionModel !== undefined) {
    payload.isFusedCursorPredictionModel = config.isFusedCursorPredictionModel;
  }
  return payload;
}

function buildExactCursorPayload(
  request: ZedRequest,
  exactPayload: Record<string, any>,
  config: CursorCppConfig | null,
) {
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
  const fileVersion = stableFileVersion(
    cursorCurrentFilePath(request),
    payload.currentFile.contents,
  );
  payload.currentFile.sha256Hash = fileVersion.hash;
  payload.currentFile.fileVersion =
    Number(payload.currentFile.fileVersion) > 0
      ? payload.currentFile.fileVersion
      : fileVersion.version;
  payload.currentFile.relyOnFilesync = false;

  normalizeFileDiffHistories(payload, now);
  absolutizeCurrentFileScopedPaths(payload, request);
  stripNoisyZedContext(payload);

  payload.workspaceId = cursorWorkspaceIdForRequest(request, payload.workspaceId);
  payload.clientTime = now;
  payload.timeSinceRequestStart = 0;
  payload.timeAtRequestSend = now;
  payload.clientTimezoneOffset = new Date().getTimezoneOffset();
  payload.enableMoreContext =
    process.env.ZED_CURSOR_PROXY_MORE_CONTEXT === "1" ||
    Boolean(payload.enableMoreContext);
  payload.cppIntentInfo = payload.cppIntentInfo ?? { source: "typing" };
  if (payload.cppIntentInfo.source === "line_change") {
    payload.cppIntentInfo.source = "typing";
  }

  return applyCppConfigToPayload(payload, config);
}

function buildLegacyCursorPayload(request: ZedRequest, config: CursorCppConfig | null) {
  const payload = structuredClone(defaultStreamCppPayload);
  const relPath = relativePath(request);
  const cursorPath = cursorCurrentFilePath(request);
  const now = Date.now();
  const lineEnding = request.contents.includes("\r\n") ? "\r\n" : "\n";
  const diffHistory = formatDiffHistory(
    previousContentsByPath.get(relPath) ?? request.contents,
    request.contents,
  );
  rememberContents(relPath, request.contents);

  payload.currentFile = {
    ...payload.currentFile,
    relativeWorkspacePath: cursorPath,
    contents: request.contents,
    cursorPosition: {
      line: request.cursor.line,
      column: request.cursor.column,
    },
    languageId: languageId(request.language),
    totalNumberOfLines: request.contents.split(lineEnding).length,
    workspaceRootPath: request.workspace_root ?? "",
    lineEnding,
    fileVersion: stableFileVersion(cursorPath, request.contents).version,
    sha256Hash: stableFileVersion(cursorPath, request.contents).hash,
  };
  payload.enableMoreContext = process.env.ZED_CURSOR_PROXY_MORE_CONTEXT === "1";
  payload.fileDiffHistories = [
    {
      fileName: cursorPath,
      diffHistory,
      diffHistoryTimestamps: diffHistory.map(() => now),
    },
  ];
  payload.diffHistory = diffHistory;
  payload.workspaceId = cursorWorkspaceIdForRequest(request);
  payload.cppIntentInfo = { source: "typing" };
  payload.clientTime = now;
  payload.timeSinceRequestStart = 0;
  payload.timeAtRequestSend = now;
  payload.clientTimezoneOffset = new Date().getTimezoneOffset();

  return applyCppConfigToPayload(payload, config);
}

function buildCursorPayload(request: ZedRequest, config: CursorCppConfig | null) {
  const exactPayload = request.cursorRequest ?? request.cursor_request;
  if (exactPayload) {
    return buildExactCursorPayload(request, exactPayload, config);
  }

  return buildLegacyCursorPayload(request, config);
}

function tabContextCacheKeyInput(request: ZedRequest, payload: Record<string, any>) {
  const cursor = payload.currentFile?.cursorPosition ?? request.cursor;
  return makeTabContextCacheInput({
    workspaceId: payload.workspaceId ?? request.workspace_root ?? "",
    relativeWorkspacePath:
      payload.currentFile?.relativeWorkspacePath ?? relativePath(request),
    line: cursor?.line ?? 0,
    column: cursor?.column ?? 0,
    contents: payload.currentFile?.contents ?? request.contents,
  });
}

function tabContextCacheKey(request: ZedRequest, payload: Record<string, any>) {
  const input = tabContextCacheKeyInput(request, payload);
  return [
    input.workspaceId,
    input.relativeWorkspacePath,
    input.line,
    input.column,
    crypto.createHash("sha256").update(input.contents).digest("hex").slice(0, 16),
  ].join(":");
}

function buildRefreshTabContextPayload(request: ZedRequest, streamPayload: Record<string, any>) {
  const now = Date.now();
  const payload: Record<string, any> = refreshTabContextPayloadFromStream(streamPayload, {
    now,
    modelName: process.env.CURSOR_TAB_MODEL ?? "fast",
    workspaceId: cursorWorkspaceIdForRequest(request, streamPayload.workspaceId),
    supportsCpt: SUPPORTS_CPT,
    supportsCrlfCpt: SUPPORTS_CPT,
  });
  // Cursor accepts linter errors on StreamCpp, but RefreshTabContext currently rejects
  // Zed-shaped linter payloads before retrieval runs. Keep diagnostics on currentFile
  // and let StreamCpp receive the full lint context.
  const repo = repositoryInfo(request);
  if (repo) {
    payload.repositoryInfo = repo;
  }
  return payload;
}

function cachedRefreshTabContext(request: ZedRequest, payload: Record<string, any>) {
  const ttlMs = Number(process.env.ZED_CURSOR_PROXY_TAB_CONTEXT_TTL_MS ?? "30000");
  const cached = cachedTabContexts.get(tabContextCacheKeyInput(request, payload), ttlMs);
  if (cached) {
    appendCapture({
      schema: 1,
      capturedAt: new Date().toISOString(),
      type: "refresh-tab-context-cache-hit",
      source: cached.source,
      relativePath: relativePath(request),
      codeResultsCount: cached.codeResults.length,
    });
    return cached.codeResults;
  }
  return [];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function fetchRefreshTabContext(
  request: ZedRequest,
  payload: Record<string, any>,
  config: CursorCppConfig | null,
) {
  if (process.env.ZED_CURSOR_PROXY_REFRESH_TAB_CONTEXT === "0") {
    return [];
  }

  const ttlMs = Number(process.env.ZED_CURSOR_PROXY_TAB_CONTEXT_TTL_MS ?? "30000");
  const cacheInput = tabContextCacheKeyInput(request, payload);
  const cached = cachedTabContexts.get(cacheInput, ttlMs);
  if (cached) {
    return cached.codeResults;
  }

  const requestBuildStartedAt = performance.now();
  const refreshPayload = buildRefreshTabContextPayload(request, payload);
  if (!refreshPayload.repositoryInfo) {
    return [];
  }
  const protoBuffer = Buffer.from(
    RefreshTabContextRequest.encode(
      RefreshTabContextRequest.create(refreshPayload),
    ).finish(),
  );
  const requestBuildMs = Math.round((performance.now() - requestBuildStartedAt) * 1000) / 1000;
  const requestId = crypto.randomUUID();
  const endpoint = refreshTabContextEndpoint(config);
  const timeoutMs = Number(process.env.ZED_CURSOR_PROXY_TAB_CONTEXT_TIMEOUT_MS ?? "5000");

  appendCapture({
    schema: 1,
    capturedAt: new Date().toISOString(),
    type: "refresh-tab-context-request",
    requestId,
    requestBuildMs,
    endpoint: endpoint.toString(),
    relativePath: relativePath(request),
    cursor: request.cursor,
    cursorPayload: refreshPayload,
  });

  const codeResults = await withTimeout(
    new Promise<any[]>((resolve, reject) => {
      const networkStartedAt = performance.now();
      const req = https.request(
        {
          hostname: endpoint.hostname,
          port: Number(endpoint.port || 443),
          path: `${endpoint.pathname}${endpoint.search}`,
          method: "POST",
          headers: {
            ...cursorHeaders(protoBuffer.length, requestId),
            "content-type": "application/proto",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            const responseBody = maybeDecompressHttpBody(Buffer.concat(chunks), res.headers);
            if (res.statusCode && res.statusCode >= 400) {
              reject(
                new Error(
                  `Cursor RefreshTabContext failed with HTTP ${res.statusCode}: ${responseBody
                    .toString("utf8")
                    .slice(0, 500)}`,
                ),
              );
              return;
            }
            try {
              const decoded = RefreshTabContextResponse.toObject(
                RefreshTabContextResponse.decode(maybeStripConnectEnvelope(responseBody)),
                { defaults: false },
              ) as { codeResults?: any[]; code_results?: any[] };
              const results = decoded.codeResults ?? decoded.code_results ?? [];
              appendCapture({
                schema: 1,
                capturedAt: new Date().toISOString(),
                type: "refresh-tab-context-response",
                requestId,
                status: res.statusCode,
                endpoint: endpoint.toString(),
                networkMs: Math.round((performance.now() - networkStartedAt) * 1000) / 1000,
                codeResultsCount: results.length,
              });
              resolve(results);
            } catch (error) {
              appendCapture({
                schema: 1,
                capturedAt: new Date().toISOString(),
                type: "refresh-tab-context-decode-error",
                requestId,
                status: res.statusCode,
                endpoint: endpoint.toString(),
                contentType: res.headers["content-type"],
                contentEncoding: res.headers["content-encoding"],
                firstBytesHex: responseBody.subarray(0, 24).toString("hex"),
                bodyLength: responseBody.length,
                error: error instanceof Error ? error.message : String(error),
              });
              reject(error);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(protoBuffer);
      req.end();
    }),
    timeoutMs,
    "RefreshTabContext",
  ).catch((error) => {
    appendCapture({
      schema: 1,
      capturedAt: new Date().toISOString(),
      type: "refresh-tab-context-error",
      requestId,
      endpoint: endpoint.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    if (DEBUG) {
      console.error(
        JSON.stringify({
          refreshTabContextError: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return [];
  });

  cachedTabContexts.set(cacheInput, codeResults);

  return codeResults;
}

function refreshTabContextInBackground(
  request: ZedRequest,
  payload: Record<string, any>,
  config: CursorCppConfig | null,
) {
  const cacheKey = tabContextCacheKey(request, payload);
  if (inFlightTabContextRefreshes.has(cacheKey)) {
    return;
  }

  inFlightTabContextRefreshes.add(cacheKey);
  fetchRefreshTabContext(request, payload, config)
    .catch((error) => {
      appendCapture({
        schema: 1,
        capturedAt: new Date().toISOString(),
        type: "refresh-tab-context-background-error",
        relativePath: relativePath(request),
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      inFlightTabContextRefreshes.delete(cacheKey);
    });
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
  config: CursorCppConfig | null,
): Promise<CursorResult> {
  const token = CURSOR_BEARER_TOKEN;
  if (!token) {
    throw new Error("Missing CURSOR_BEARER_TOKEN in cursor-unchained/.env");
  }

  const requestBuildStartedAt = performance.now();
  const protoBuffer = Buffer.from(
    Request.encode(Request.create(payload)).finish(),
  );
  const envelope = connectEnvelope(protoBuffer);
  const requestBuildMs = Math.round((performance.now() - requestBuildStartedAt) * 1000) / 1000;

  const requestId =
    process.env.ZED_CURSOR_PROXY_FIXED_REQUEST_ID ?? crypto.randomUUID();
  const endpoint = streamCppEndpoint(config);
  const options: https.RequestOptions = {
    hostname: endpoint.hostname,
    port: Number(endpoint.port || 443),
    path: `${endpoint.pathname}${endpoint.search}`,
    method: "POST",
    headers: {
      ...cursorHeaders(envelope.length, requestId),
      "x-cursor-streaming": "true",
    },
  };

  appendCapture({
    schema: 1,
    capturedAt: new Date().toISOString(),
    type: "stream-cpp-request",
    source,
    requestId,
    requestBuildMs,
    endpoint: endpoint.toString(),
    relativePath: relativePath(request),
    cursor: request.cursor,
    cursorPayload: payload,
    zedExternalProxy:
      (request.cursorRequest ?? request.cursor_request)?.zedExternalProxy ?? null,
    configSummary: config
      ? {
          cppUrl: config.cppUrl,
          geoCppBackendUrl: config.geoCppBackendUrl,
          globalDebounceDurationMillis: config.globalDebounceDurationMillis,
          clientDebounceDurationMillis: config.clientDebounceDurationMillis,
          allowsTabChunks: config.allowsTabChunks,
          isFusedCursorPredictionModel: config.isFusedCursorPredictionModel,
        }
      : null,
  });

  return await new Promise((resolve, reject) => {
    const networkStartedAt = performance.now();
    const req = https.request(options, (res: IncomingMessage) => {
      let dataBuffer = Buffer.alloc(0);
      let settled = false;
      let responseDecodeMs = 0;
      const result: CursorResult = {
        status: res.statusCode,
        source,
        requestId,
        text: "",
        rangeToReplace: null,
        cursorPredictionTarget: null,
      };

      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        appendCapture({
          schema: 1,
          capturedAt: new Date().toISOString(),
          type: "stream-cpp-response",
          source,
          requestId,
          status: result.status,
          endpoint: endpoint.toString(),
          networkMs: Math.round((performance.now() - networkStartedAt) * 1000) / 1000,
          responseDecodeMs: Math.round(responseDecodeMs * 1000) / 1000,
          textLength: result.text.length,
          hasJump: Boolean(result.cursorPredictionTarget),
          hasRange: Boolean(result.rangeToReplace),
        });
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

          const decodeStartedAt = performance.now();
          const decoded = StreamCppResponse.decode(msgData) as any;
          responseDecodeMs += performance.now() - decodeStartedAt;
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
  if (process.env.ZED_CURSOR_PROXY_MOCK_RESULT) {
    return {
      status: 200,
      source: "exact",
      ...JSON.parse(process.env.ZED_CURSOR_PROXY_MOCK_RESULT),
    };
  }

  const exactPayload = request.cursorRequest ?? request.cursor_request;
  const config = cppConfigFast();
  const payload = buildCursorPayload(request, config);
  const codeResults = cachedRefreshTabContext(request, payload);
  if (codeResults.length) {
    payload.codeResults = codeResults;
  }
  refreshTabContextInBackground(request, payload, config);
  const exactResult = await streamCppPayload(
    request,
    payload,
    exactPayload ? "exact" : "legacy",
    config,
  );

  if (
    process.env.ZED_CURSOR_PROXY_LEGACY_FALLBACK === "1" &&
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
    return streamCppPayload(
      request,
      buildLegacyCursorPayload(request, config),
      "legacy",
      config,
    );
  }

  return exactResult;
}

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        cppConfig: cachedCppConfig
          ? {
              ageMs: Date.now() - cachedCppConfig.fetchedAt,
              loaded: Boolean(cachedCppConfig.config),
              error: cachedCppConfig.error,
              config: cachedCppConfig.config
                ? {
                    cppUrl: cachedCppConfig.config.cppUrl,
                    geoCppBackendUrl: cachedCppConfig.config.geoCppBackendUrl,
                    globalDebounceDurationMillis:
                      cachedCppConfig.config.globalDebounceDurationMillis,
                    clientDebounceDurationMillis:
                      cachedCppConfig.config.clientDebounceDurationMillis,
                    allowsTabChunks: cachedCppConfig.config.allowsTabChunks,
                  }
                : null,
            }
          : null,
      });
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/accept" ||
        url.pathname === "/reject" ||
        url.pathname === "/partial_accept")
    ) {
      const body = (await req.json().catch(() => ({}))) as { id?: string };
      const fate =
        url.pathname === "/accept"
          ? "accept"
          : url.pathname === "/partial_accept"
            ? "partial_accept"
            : "reject";
      let upstreamFate: "sent" | "disabled" | "missing-metadata" | "missing-id" | "failed" =
        "missing-id";
      let upstreamFateError: string | undefined;
      if (!ACCEPT_TELEMETRY) {
        upstreamFate = "disabled";
      } else if (body.id) {
        const metadata = acceptMetadataByPredictionId.get(body.id);
        if (metadata) {
          try {
            if (fate === "accept") {
              await recordCppAcceptFate(metadata);
              acceptMetadataByPredictionId.delete(body.id);
            } else if (fate === "partial_accept") {
              await recordCppPartialAcceptFate(metadata);
            } else {
              await recordCppRejectFate(metadata);
              acceptMetadataByPredictionId.delete(body.id);
            }
            upstreamFate = "sent";
          } catch (error) {
            upstreamFate = "failed";
            upstreamFateError = error instanceof Error ? error.message : String(error);
          }
        } else {
          upstreamFate = "missing-metadata";
        }
      }
      appendCapture({
        schema: 1,
        capturedAt: new Date().toISOString(),
        type: fate,
        id: body.id,
        upstreamFate,
        upstreamFateError,
      });
      if (DEBUG) {
        console.error(
          JSON.stringify({
            [fate === "accept"
              ? "accepted"
              : fate === "partial_accept"
                ? "partialAccepted"
                : "rejected"]: body.id ? "prediction" : "missing-id",
            upstreamFate,
            upstreamFateError,
          }),
        );
      }
      return json({
        ok: true,
        [fate === "accept"
          ? "upstream_accept"
          : fate === "partial_accept"
            ? "upstream_partial_accept"
            : "upstream_reject"]: upstreamFate,
      });
    }

    if (req.method !== "POST" || url.pathname !== "/predict") {
      return json({ error: "not found" }, 404);
    }

    try {
      const zedRequest = (await req.json()) as ZedRequest;
      const startedAt = performance.now();
      const cursorResult = await streamCpp(zedRequest);
      const normalizationStartedAt = performance.now();
      const zedResponse = toZedResponse(zedRequest, cursorResult, {
        debug: DEBUG,
        debugPath: relativePath(zedRequest),
      });
      const normalizationMs =
        Math.round((performance.now() - normalizationStartedAt) * 1000) / 1000;
      if (
        cursorResult.requestId &&
        zedResponse.id_source === "cursor" &&
        (zedResponse.edits.length > 0 || zedResponse.jump)
      ) {
        acceptMetadataByPredictionId.set(zedResponse.id, {
          requestId: cursorResult.requestId,
          extension: extensionForPath(relativePath(zedRequest)),
        });
      }
      const latencyMs = Math.round(performance.now() - startedAt);
      appendCapture({
        schema: 1,
        capturedAt: new Date().toISOString(),
        latencyMs,
        normalizationMs,
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

void fetchCppConfig();

console.log(`Zed Cursor proxy listening on http://127.0.0.1:${PORT}/predict`);
