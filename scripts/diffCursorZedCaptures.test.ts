import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import protobuf from "protobufjs";
import {
  decodeStreamCppRequest,
  semanticDiff,
  summarizeCapture,
  summarizeFiles,
} from "./diffCursorZedCaptures";

describe("Cursor/Zed capture diff", () => {
  test("summarizes private contents by hash and length", () => {
    const summary = summarizeCapture("cursor", {
      typeName: "aiserver.v1.StreamCppRequest",
      direction: "encode",
      message: {
        currentFile: {
          relativeWorkspacePath: "src/private.ts",
          contents: "const secret = 'do not print me';\n",
          languageId: "typescript",
        },
        modelName: "fast",
        lspSuggestedItems: [{ label: "nullthrows" }],
      },
    });

    expect(summary?.currentFile?.contents?.length).toBe(34);
    expect(summary?.currentFile?.contents?.lines).toBe(2);
    expect(summary?.currentFile?.contents?.sha256).toHaveLength(16);
    expect(JSON.stringify(summary)).not.toContain("do not print me");
    expect(summary?.request?.counts.lspSuggestedItems).toBe(1);
  });

  test("reports semantic protocol mismatches without full contents", () => {
    const cursor = summarizeCapture("cursor", {
      typeName: "aiserver.v1.StreamCppRequest",
      direction: "encode",
      message: {
        currentFile: { relativeWorkspacePath: "src/a.ts", contents: "abc" },
        supportsCpt: true,
        lspSuggestedItems: [{ label: "one" }],
      },
    });
    const zed = summarizeCapture("zed", {
      request: {
        cursorRequest: {
          currentFile: { relativeWorkspacePath: "src/a.ts", contents: "abcd" },
          supportsCpt: false,
          lspSuggestedItems: [],
        },
      },
    });

    expect(cursor).toBeTruthy();
    expect(zed).toBeTruthy();
    const diff = semanticDiff(cursor!, zed!);
    expect(diff.map((entry) => entry.field)).toContain("request.supportsCpt");
    expect(diff.map((entry) => entry.field)).toContain("request.counts.lspSuggestedItems");
    expect(JSON.stringify(diff)).not.toContain("abcd");
  });

  test("decodes captured StreamCpp request protobuf bytes", () => {
    const root = protobuf.loadSync(
      path.join(import.meta.dir, "../protobuf/streamCppRequest.proto"),
    );
    const type = root.lookupType("aiserver.v1.StreamCppRequest");
    const bytes = type.encode(
      type.create({
        currentFile: {
          relativeWorkspacePath: "src/probe.ts",
          contents: "const privateValue = 1;\n",
          languageId: "typescript",
        },
        supportsCpt: true,
        lspSuggestedItems: {
          suggestions: [{ label: "nullthrows" }],
        },
      }),
    ).finish();

    const decoded = decodeStreamCppRequest(Buffer.from(bytes).toString("base64"));
    expect(decoded.currentFile.relativeWorkspacePath).toBe("src/probe.ts");

    const summary = summarizeCapture("cursor", {
      typeName: "aiserver.v1.StreamCppRequest",
      requestBodyBase64: Buffer.from(bytes).toString("base64"),
    });
    expect(summary?.request?.supportsCpt).toBe(true);
    expect(summary?.request?.counts.lspSuggestedItems).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("privateValue");
  });

  test("compares the latest request from noisy capture files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-zed-captures-"));
    const cursorFile = path.join(dir, "cursor.jsonl");
    const zedFile = path.join(dir, "zed.jsonl");

    fs.writeFileSync(
      cursorFile,
      [
        JSON.stringify({
          typeName: "aiserver.v1.StreamCppRequest",
          direction: "encode",
          message: {
            currentFile: { relativeWorkspacePath: "old.ts", contents: "old" },
          },
        }),
        JSON.stringify({
          typeName: "aiserver.v1.StreamCppRequest",
          direction: "encode",
          message: {
            currentFile: { relativeWorkspacePath: "new.ts", contents: "new" },
          },
        }),
      ].join("\n"),
    );
    fs.writeFileSync(
      zedFile,
      [
        JSON.stringify({
          request: {
            cursorRequest: {
              currentFile: { relativeWorkspacePath: "old.ts", contents: "old" },
            },
          },
        }),
        JSON.stringify({
          request: {
            cursorRequest: {
              currentFile: { relativeWorkspacePath: "new.ts", contents: "new" },
            },
          },
        }),
      ].join("\n"),
    );

    const { cursor, zed, diff } = summarizeFiles(cursorFile, zedFile);
    expect(cursor.currentFile?.path).toBe("new.ts");
    expect(zed.currentFile?.path).toBe("new.ts");
    expect(diff.map((entry) => entry.field)).not.toContain("currentFile.path");
  });
});
