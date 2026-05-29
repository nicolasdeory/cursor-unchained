import protobuf from "protobufjs";
import https from "node:https";
import {
  CURSOR_BEARER_TOKEN,
  X_CURSOR_CLIENT_VERSION,
  X_SESSION_ID,
} from "../src/lib/env";

export type PredictionAcceptMetadata = {
  requestId: string;
  extension: string;
};

const CURSOR_CPP_FATE_HOST =
  process.env.CURSOR_CPP_FATE_HOST ?? "api2.cursor.sh";
const root = await protobuf.load("./protobuf/recordCppFate.proto");
const RecordCppFateRequest = root.lookupType("aiserver.v1.RecordCppFateRequest");

function connectEnvelope(protoBuffer: Buffer) {
  const envelope = Buffer.alloc(5 + protoBuffer.length);
  envelope.writeUInt8(0, 0);
  envelope.writeUInt32BE(protoBuffer.length, 1);
  protoBuffer.copy(envelope, 5);
  return envelope;
}

export function extensionForPath(relativePath: string) {
  const basename = relativePath.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) {
    return "";
  }
  const extension = basename.slice(dot + 1).toLowerCase();
  return extension.length < 8 ? extension : "";
}

export function buildRecordCppAcceptFateEnvelope(
  metadata: PredictionAcceptMetadata,
  performanceNowTime = performance.now(),
) {
  return connectEnvelope(buildRecordCppAcceptFateProto(metadata, performanceNowTime));
}

export function buildRecordCppAcceptFateProto(
  metadata: PredictionAcceptMetadata,
  performanceNowTime = performance.now(),
) {
  const payload = RecordCppFateRequest.create({
    requestId: metadata.requestId,
    performanceNowTime,
    fate: 1,
    extension: metadata.extension,
  });
  return Buffer.from(RecordCppFateRequest.encode(payload).finish());
}

export async function recordCppAcceptFate(metadata: PredictionAcceptMetadata) {
  const token = CURSOR_BEARER_TOKEN;
  if (!token) {
    throw new Error("Missing CURSOR_BEARER_TOKEN in cursor-unchained/.env");
  }

  const body = buildRecordCppAcceptFateProto(metadata);
  const options: https.RequestOptions = {
    hostname: CURSOR_CPP_FATE_HOST,
    port: 443,
    path: "/aiserver.v1.CppService/RecordCppFate",
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "x-cursor-client-type": "ide",
      "x-cursor-client-version": X_CURSOR_CLIENT_VERSION,
      "x-request-id": crypto.randomUUID(),
      "x-session-id": X_SESSION_ID,
      authorization: `Bearer ${token}`,
      "content-length": body.length,
    },
  };

  await new Promise<void>((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          const body = Buffer.concat(chunks).toString("utf8");
          reject(new Error(`Cursor RecordCppFate failed with HTTP ${res.statusCode}: ${body}`));
          return;
        }
        resolve();
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
