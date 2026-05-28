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
