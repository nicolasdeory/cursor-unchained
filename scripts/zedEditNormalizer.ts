export type ZedPosition = {
  line: number;
  column: number;
};

export type ZedRange = {
  start: ZedPosition;
  end: ZedPosition;
};

export type ZedRequestForEdit = {
  path: string;
  absolute_path?: string;
  workspace_root?: string;
  contents: string;
  cursor: ZedPosition;
};

export type CursorResultForEdit = {
  text: string;
  rangeToReplace?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  } | null;
};

export type NormalizedEdit = {
  range: ZedRange;
  text: string;
  reason: string;
};

type Candidate = {
  newContents: string;
  reason: string;
  score: number;
  startLine: number;
  endLineExclusive: number;
};

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

function startOffsetForLine(contents: string, targetLine: number): number {
  if (targetLine <= 0) {
    return 0;
  }

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

function lineCount(contents: string): number {
  return contents.split("\n").length;
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

function sameText(left: string, right: string): boolean {
  return left.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n");
}

function minimalDocumentEdit(
  oldContents: string,
  newContents: string,
  reason: string,
): NormalizedEdit | null {
  if (sameText(oldContents, newContents)) {
    return null;
  }

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
    reason,
  };
}

function normalizeCandidateText(text: string): string[] {
  const variants = new Set<string>();
  variants.add(text);
  variants.add(text.replace(/^\n+/, ""));
  variants.add(text.replace(/\n+$/, ""));
  variants.add(text.replace(/^\n+/, "").replace(/\n+$/, ""));
  return [...variants].filter((variant) => variant.length > 0);
}

function lineAt(contents: string, line: number): string {
  return contents.split("\n")[line] ?? "";
}

function trimmedNonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
    if (isLineBoundary(text, overlap) && existingPrefix.endsWith(text.slice(0, overlap))) {
      return text.slice(overlap);
    }
  }
  return text;
}

function mergeWithExistingSuffix(text: string, existingSuffix: string): string {
  const maxOverlap = Math.min(text.length, existingSuffix.length);
  for (let overlap = maxOverlap; overlap >= 8; overlap--) {
    if (isLineBoundary(existingSuffix, overlap) && text.endsWith(existingSuffix.slice(0, overlap))) {
      return text + existingSuffix.slice(overlap);
    }
  }
  if (
    text.length > 0 &&
    existingSuffix.length > 0 &&
    !text.endsWith("\n") &&
    !existingSuffix.startsWith("\n")
  ) {
    return `${text}\n${existingSuffix}`;
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
    if (trimmed) {
      if (lines[index + 1]?.trim() === trimmed) {
        output.push(line);
        index += 1;
        continue;
      }
      if (lines[index + 1]?.trim() === "" && lines[index + 2]?.trim() === trimmed) {
        output.push(line);
        index += 2;
        continue;
      }
    }
    output.push(line);
  }

  return output.join("\n") + (hasTrailingNewline ? "\n" : "");
}

function declarationNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*(?:export\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/,
    );
    if (match) {
      names.add(match[1]);
    }
  }
  return names;
}

function declarationCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*(?:export\s+)?(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/,
    );
    if (match) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
    }
  }
  return counts;
}

function duplicateDeclarationPenalty(oldContents: string, newContents: string): number {
  const oldCounts = declarationCounts(oldContents);
  const newCounts = declarationCounts(newContents);
  let penalty = 0;

  for (const [name, newCount] of newCounts) {
    const oldCount = oldCounts.get(name) ?? 0;
    if (newCount > Math.max(1, oldCount)) {
      penalty += 500 + (newCount - oldCount) * 100;
    }
  }

  return penalty;
}

function adjacentDuplicatePenalty(text: string): number {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  let penalty = 0;
  for (let index = 0; index < lines.length - 1; index++) {
    if (lines[index] === lines[index + 1]) {
      penalty += 400;
    }
  }
  return penalty;
}

function windowOverlapScore(oldWindow: string, candidateText: string): number {
  const oldLines = new Set(trimmedNonEmptyLines(oldWindow));
  let score = 0;
  for (const line of trimmedNonEmptyLines(candidateText)) {
    if (oldLines.has(line)) {
      score++;
    }
  }
  return score;
}

function replacementMatchesCursorLine(
  request: ZedRequestForEdit,
  replacement: string,
  startLine: number,
): boolean {
  const currentLine = lineAt(request.contents, request.cursor.line);
  const currentPrefix = currentLine
    .slice(0, Math.min(request.cursor.column, currentLine.length))
    .replace(/[ \t]+$/, "");
  const replacementLines = replacement.split("\n");
  const relativeCursorLine = request.cursor.line - startLine;

  if (relativeCursorLine < 0 || relativeCursorLine >= replacementLines.length) {
    return Math.abs(relativeCursorLine) <= 1 && currentPrefix.trim().length === 0;
  }

  const replacementLine = replacementLines[relativeCursorLine] ?? "";
  if (currentPrefix.trim().length === 0) {
    return replacementLine.startsWith(currentPrefix) || replacementLine.trim().length > 0;
  }

  return replacementLine.startsWith(currentPrefix);
}

function applyLineReplacement(
  request: ZedRequestForEdit,
  replacementText: string,
  startLine: number,
  endLineExclusive: number,
): string {
  const startOffset = startOffsetForLine(request.contents, startLine);
  const endOffset = startOffsetForLine(request.contents, endLineExclusive);
  const prefix = request.contents.slice(0, startOffset);
  const suffix = request.contents.slice(endOffset);
  const replacement = collapseNearbyDuplicateLines(
    trimExistingPrefixOverlap(replacementText, prefix),
  );
  return prefix + mergeWithExistingSuffix(replacement, suffix);
}

function scoreCandidate(
  request: ZedRequestForEdit,
  candidate: Omit<Candidate, "score">,
): Candidate | null {
  if (sameText(request.contents, candidate.newContents)) {
    return null;
  }

  const edit = minimalDocumentEdit(request.contents, candidate.newContents, candidate.reason);
  if (!edit) {
    return null;
  }

  const startOffset = offsetForPosition(request.contents, edit.range.start);
  const endOffset = offsetForPosition(request.contents, edit.range.end);
  const oldText = request.contents.slice(startOffset, endOffset);
  const editLineDistance = Math.min(
    Math.abs(candidate.startLine - request.cursor.line),
    Math.abs(candidate.endLineExclusive - request.cursor.line),
  );
  const changedTextSize = oldText.length + edit.text.length;
  const candidateText = candidate.newContents.slice(
    startOffsetForLine(candidate.newContents, candidate.startLine),
    startOffsetForLine(candidate.newContents, candidate.endLineExclusive),
  );
  const oldWindow = request.contents.slice(
    startOffsetForLine(request.contents, Math.max(0, request.cursor.line - 12)),
    startOffsetForLine(request.contents, Math.min(lineCount(request.contents), request.cursor.line + 12)),
  );
  const oldTextDeclarations = declarationNames(oldText);
  const candidateDeclarations = declarationNames(candidateText);

  let score =
    changedTextSize * 0.2 +
    editLineDistance * 12 -
    windowOverlapScore(oldWindow, candidateText) * 8 +
    duplicateDeclarationPenalty(request.contents, candidate.newContents) +
    adjacentDuplicatePenalty(candidateText);

  for (const name of oldTextDeclarations) {
    if (!candidateDeclarations.has(name)) {
      score += 300;
    }
  }

  if (edit.range.start.line > request.cursor.line + 8 || edit.range.end.line < request.cursor.line - 8) {
    score += 250;
  }

  if (edit.text.length === 0) {
    return null;
  }
  if (!/[A-Za-z0-9_$]/.test(edit.text)) {
    return null;
  }

  return { ...candidate, score };
}

function candidateFromFullText(
  request: ZedRequestForEdit,
  text: string,
  reason: string,
): Candidate | null {
  return scoreCandidate(request, {
    newContents: text,
    reason,
    startLine: 0,
    endLineExclusive: lineCount(text),
  });
}

function lineReplacementCandidates(
  request: ZedRequestForEdit,
  text: string,
): Candidate[] {
  const candidates: Candidate[] = [];
  const totalLines = lineCount(request.contents);
  const candidateLineCount = Math.max(1, text.split("\n").length);
  const startMin = Math.max(0, request.cursor.line - 8);
  const startMax = Math.min(totalLines, request.cursor.line + 2);

  for (const replacement of normalizeCandidateText(text)) {
    for (let startLine = startMin; startLine <= startMax; startLine++) {
      if (!replacementMatchesCursorLine(request, replacement, startLine)) {
        continue;
      }

      const endMax = Math.min(
        totalLines,
        Math.max(startLine + 1, startLine + candidateLineCount + 6),
      );
      for (let endLineExclusive = startLine + 1; endLineExclusive <= endMax; endLineExclusive++) {
        const newContents = applyLineReplacement(
          request,
          replacement,
          startLine,
          endLineExclusive,
        );
        const candidate = scoreCandidate(request, {
          newContents,
          reason: `line-window:${startLine}-${endLineExclusive}`,
          startLine,
          endLineExclusive,
        });
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }
  }

  return candidates;
}

function bestCandidate(candidates: Candidate[]): Candidate | null {
  return candidates.sort((left, right) => left.score - right.score)[0] ?? null;
}

function cursorEditCandidates(
  request: ZedRequestForEdit,
  result: CursorResultForEdit,
): { directEdit: NormalizedEdit | null; candidates: Candidate[] } {
  if (!result.text) {
    return { directEdit: null, candidates: [] };
  }
  if (sameText(request.contents, result.text)) {
    return { directEdit: null, candidates: [] };
  }

  const cursorOffset = offsetForPosition(request.contents, request.cursor);
  const prefixAtCursor = request.contents.slice(0, cursorOffset);
  const suffixAtCursor = request.contents.slice(cursorOffset);
  const candidates: Candidate[] = [];
  const resultLooksLikeDocumentPrefix = prefixAtCursor.includes("\n") || cursorOffset > 200;

  if (
    resultLooksLikeDocumentPrefix &&
    ((prefixAtCursor.trim().length > 0 && result.text.startsWith(prefixAtCursor)) ||
      (cursorOffset >= 24 && commonPrefixLength(request.contents, result.text) >= 24))
  ) {
    const edit = minimalDocumentEdit(request.contents, result.text, "document-like");
    if (edit) {
      return { directEdit: edit, candidates };
    }
  }

  if (result.rangeToReplace) {
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
    if (isValidRange(range)) {
      const startOffset = offsetForPosition(request.contents, range.start);
      const endOffset = offsetForPosition(request.contents, range.end);
      const newContents =
        request.contents.slice(0, startOffset) +
        result.text +
        request.contents.slice(endOffset);
      const candidate = scoreCandidate(request, {
        newContents,
        reason: "cursor-range",
        startLine: range.start.line,
        endLineExclusive: range.end.line + 1,
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  if (suffixAtCursor && result.text.endsWith(suffixAtCursor)) {
    const candidate = candidateFromFullText(
      request,
      prefixAtCursor + result.text,
      "suffix-aware",
    );
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.push(...lineReplacementCandidates(request, result.text));

  return { directEdit: null, candidates };
}

export function debugNormalizeCursorEdit(
  request: ZedRequestForEdit,
  result: CursorResultForEdit,
) {
  const { directEdit, candidates } = cursorEditCandidates(request, result);
  const selected = directEdit ? null : bestCandidate(candidates);
  return {
    directEdit,
    selected,
    accepted: directEdit || (selected && selected.score < 450) ? true : false,
    candidates: candidates
      .toSorted((left, right) => left.score - right.score)
      .slice(0, 10),
  };
}

export function normalizeCursorEdit(
  request: ZedRequestForEdit,
  result: CursorResultForEdit,
): NormalizedEdit | null {
  const { directEdit, candidates } = cursorEditCandidates(request, result);
  if (directEdit) {
    return directEdit;
  }

  const selected = bestCandidate(candidates);
  if (!selected || selected.score >= 450) {
    return null;
  }

  return minimalDocumentEdit(request.contents, selected.newContents, selected.reason);
}
