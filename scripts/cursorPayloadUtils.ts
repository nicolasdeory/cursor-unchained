export function cursorDiffHistoryFromUnifiedDiff(diff: string): string {
  if (/^\d+[+-]\|/m.test(diff)) {
    return diff;
  }

  const output: string[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (oldLine === 0 && newLine === 0) {
      continue;
    }

    if (line.startsWith("-")) {
      output.push(`${oldLine}-|${line.slice(1)}`);
      oldLine++;
    } else if (line.startsWith("+")) {
      output.push(`${newLine}+|${line.slice(1)}`);
      newLine++;
    } else {
      oldLine++;
      newLine++;
    }
  }

  return output.length ? output.join("\n") : diff;
}

export function normalizeDiffHistoryTimestamps(
  timestamps: unknown,
  length: number,
  now: number,
): number[] {
  if (
    Array.isArray(timestamps) &&
    timestamps.length === length &&
    timestamps.every((timestamp) => Number.isFinite(timestamp) && timestamp > 0)
  ) {
    return timestamps;
  }

  return Array.from({ length }, (_, index) => now - (length - index - 1) * 1000);
}

export function normalizeFileDiffHistories(payload: any, now: number) {
  normalizeCursorContextPaths(payload);

  payload.fileDiffHistories = (payload.fileDiffHistories ?? []).map(
    (history: any) => {
      const diffHistory = (history.diffHistory ?? []).map((diff: string) =>
        cursorDiffHistoryFromUnifiedDiff(String(diff)),
      );
      return {
        ...history,
        diffHistory,
        diffHistoryTimestamps: normalizeDiffHistoryTimestamps(
          history.diffHistoryTimestamps,
          diffHistory.length,
          now,
        ),
      };
    },
  );

  payload.diffHistory = (payload.diffHistory ?? []).map((diff: string) =>
    cursorDiffHistoryFromUnifiedDiff(String(diff)),
  );
}

export function normalizeCursorContextPaths(payload: any) {
  const currentFile = payload.currentFile ?? {};
  const currentPath = currentFile.relativeWorkspacePath;
  const workspaceRoot = currentFile.workspaceRootPath ?? payload.workspaceId;
  const workspaceName =
    typeof workspaceRoot === "string" && workspaceRoot.length > 0
      ? workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)
      : undefined;

  const normalizePath = (value: unknown) => {
    if (typeof value !== "string" || value.length === 0) {
      return value;
    }

    if (
      typeof workspaceRoot === "string" &&
      workspaceRoot.length > 0 &&
      (value === workspaceRoot || value.startsWith(`${workspaceRoot}/`))
    ) {
      return value.slice(workspaceRoot.length).replace(/^[/\\]/, "");
    }

    if (workspaceName && value.startsWith(`${workspaceName}/`)) {
      return value.slice(workspaceName.length + 1);
    }

    return value;
  };

  if (typeof currentPath === "string") {
    currentFile.relativeWorkspacePath = normalizePath(currentPath);
  }

  for (const history of payload.fileDiffHistories ?? []) {
    history.fileName = normalizePath(history.fileName);
  }

  for (const file of payload.additionalFiles ?? []) {
    file.relativeWorkspacePath = normalizePath(file.relativeWorkspacePath);
  }

  for (const result of payload.codeResults ?? []) {
    const codeBlock = result?.codeBlock;
    if (codeBlock) {
      codeBlock.relativeWorkspacePath = normalizePath(codeBlock.relativeWorkspacePath);
    }
  }
}

export function refreshTabContextPayloadFromStream(
  streamPayload: any,
  options: {
    now: number;
    modelName: string;
    workspaceId: string;
    supportsCpt: boolean;
    supportsCrlfCpt: boolean;
  },
) {
  return {
    currentFile: streamPayload.currentFile,
    modelName: streamPayload.modelName ?? options.modelName,
    fileDiffHistories: streamPayload.fileDiffHistories ?? [],
    additionalFiles: streamPayload.additionalFiles ?? [],
    clientTime: options.now,
    timeSinceRequestStart: 0,
    timeAtRequestSend: options.now,
    isDebug: Boolean(streamPayload.isDebug),
    workspaceId: options.workspaceId,
    supportsCpt: streamPayload.supportsCpt ?? options.supportsCpt,
    supportsCrlfCpt:
      streamPayload.supportsCrlfCpt ??
      streamPayload.supportsCpt ??
      options.supportsCrlfCpt,
  };
}
