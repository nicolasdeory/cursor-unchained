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

  test("round-trips Cursor index code results between RefreshTabContext and StreamCpp", async () => {
    const responseRoot = await protobuf.load("./protobuf/refreshTabContextResponse.proto");
    const RefreshTabContextResponse = responseRoot.lookupType(
      "aiserver.v1.RefreshTabContextResponse",
    );
    const requestRoot = await protobuf.load("./protobuf/streamCppRequest.proto");
    const StreamCppRequest = requestRoot.lookupType("aiserver.v1.StreamCppRequest");
    const codeResult = {
      codeBlock: {
        relativeWorkspacePath: "src/related.ts",
        fileContents: "export function helper() {}\n",
        fileContentsLength: 28,
        range: {
          startPosition: { line: 1, column: 1 },
          endPosition: { line: 2, column: 1 },
        },
        contents: "function helper() {}\n",
        signatures: {
          ranges: [
            {
              startPosition: { line: 1, column: 1 },
              endPosition: { line: 1, column: 10 },
            },
          ],
        },
        detailedLines: [
          {
            text: "function helper() {}",
            lineNumber: 1,
            isSignature: true,
          },
        ],
        fileGitContext: {
          commits: [
            {
              commit: "abc123",
              author: "dev",
              date: "2026-05-30",
              message: "add helper",
            },
          ],
        },
      },
      score: 0.75,
    };

    const responseBytes = RefreshTabContextResponse.encode(
      RefreshTabContextResponse.create({ codeResults: [codeResult] }),
    ).finish();
    const decodedResponse = RefreshTabContextResponse.toObject(
      RefreshTabContextResponse.decode(responseBytes),
      { defaults: false },
    ) as any;

    expect(decodedResponse.codeResults).toHaveLength(1);
    expect(decodedResponse.codeResults[0].codeBlock).toMatchObject({
      relativeWorkspacePath: "src/related.ts",
      fileContents: "export function helper() {}\n",
      fileContentsLength: 28,
      contents: "function helper() {}\n",
    });

    const requestPayload = {
      currentFile: {
        relativeWorkspacePath: "src/file.ts",
        contents: "helper();\n",
        cursorPosition: { line: 0, column: 9 },
        languageId: "typescript",
        totalNumberOfLines: 2,
        workspaceRootPath: "/tmp/project",
        lineEnding: "\n",
      },
      timeSinceRequestStart: 0,
      timeAtRequestSend: Date.now(),
      codeResults: decodedResponse.codeResults,
    };

    expect(StreamCppRequest.verify(requestPayload)).toBeNull();
    const decodedRequest = StreamCppRequest.decode(
      StreamCppRequest.encode(StreamCppRequest.create(requestPayload)).finish(),
    ) as any;
    expect(decodedRequest.codeResults[0].codeBlock.fileContentsLength).toBe(28);
    expect(decodedRequest.codeResults[0].score).toBeCloseTo(0.75);
  });
});
