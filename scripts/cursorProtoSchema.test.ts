import { describe, expect, test } from "bun:test";
import protobuf from "protobufjs";

describe("Cursor protobuf schema", () => {
  test("encodes diagnostics and LSP suggestion labels for StreamCppRequest", async () => {
    const root = await protobuf.load("./protobuf/streamCppRequest.proto");
    const Request = root.lookupType("aiserver.v1.StreamCppRequest");
    const payload = {
      currentFile: {
        relativeWorkspacePath: "src/file.ts",
        contents: "const value = nullthrows(foo);\n",
        cursorPosition: { line: 0, column: 27 },
        dataframes: [],
        languageId: "typescript",
        diagnostics: [
          {
            message: "Cannot find name `nullthrows`.",
            range: {
              startLine: 0,
              startColumn: 14,
              endLine: 0,
              endColumn: 24,
            },
            severity: 1,
            relatedInformation: [],
          },
        ],
        totalNumberOfLines: 2,
        contentsStartAtLine: 0,
        topChunks: [],
        fileVersion: 1,
        cellStartLines: [],
        cells: [],
        relyOnFilesync: false,
        workspaceRootPath: "/tmp/project",
        lineEnding: "\n",
      },
      diffHistory: [],
      diffHistoryKeys: [],
      fileDiffHistories: [],
      mergedDiffHistories: [],
      blockDiffPatches: [],
      contextItems: [],
      parameterHints: [],
      lspContexts: [],
      additionalFiles: [],
      filesyncUpdates: [],
      timeSinceRequestStart: 0,
      timeAtRequestSend: Date.now(),
      lspSuggestedItems: {
        suggestions: [{ label: "nullthrows" }],
      },
      codeResults: [],
    };

    expect(Request.verify(payload)).toBeNull();

    const decoded = Request.decode(Request.encode(payload).finish()) as any;
    expect(decoded.currentFile.diagnostics[0]).toMatchObject({
      message: "Cannot find name `nullthrows`.",
      range: {
        startLine: 0,
        startColumn: 14,
        endLine: 0,
        endColumn: 24,
      },
      severity: 1,
      relatedInformation: [],
    });
    expect(decoded.lspSuggestedItems.suggestions[0].label).toBe("nullthrows");
  });
});
