import { normalizeCursorEdits } from "./zedEditNormalizer";

type ZedPosition = {
  line: number;
  column: number;
};

export type ZedRequestForProtocol = {
  path: string;
  contents: string;
  cursor: ZedPosition;
  cursor_request?: Record<string, any>;
  cursorRequest?: Record<string, any>;
};

export type CursorResultForProtocol = {
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
};

export type ZedExternalResponse = {
  id: string;
  id_source: "cursor" | "synthetic";
  edits: Array<{
    range: {
      start: ZedPosition;
      end: ZedPosition;
    };
    text: string;
  }>;
  jump?: {
    path: string;
    expected_content?: string;
    should_retrigger?: boolean;
    position: ZedPosition;
  };
};

export function toZedResponse(
  request: ZedRequestForProtocol,
  result: CursorResultForProtocol,
  options: {
    debug?: boolean;
    debugPath?: string;
  } = {},
): ZedExternalResponse {
  const id = result.bindingId || crypto.randomUUID();
  const idSource = result.bindingId ? "cursor" : "synthetic";
  const edits: ZedExternalResponse["edits"] = [];
  const cursorPredictionTarget = result.cursorPredictionTarget?.relativePath
    ? result.cursorPredictionTarget
    : null;

  if (options.debug) {
    console.error(
      JSON.stringify({
        path: options.debugPath ?? request.path,
        cursor: request.cursor,
        hasExactCursorPayload: Boolean(request.cursorRequest ?? request.cursor_request),
        source: result.source,
        status: result.status,
        bindingId: result.bindingId ? "present" : "missing",
        textLength: result.text.length,
        rangeToReplace: result.rangeToReplace,
        cursorPredictionTarget: result.cursorPredictionTarget,
        textPreview: result.text.slice(0, 220),
      }),
    );
  }

  if (result.text && !cursorPredictionTarget) {
    const normalizedEdits = normalizeCursorEdits(request, result);
    if (normalizedEdits.length > 0) {
      if (options.debug) {
        console.error(
          JSON.stringify({
            applied: "edits",
            path: options.debugPath ?? request.path,
            cursor: request.cursor,
            editCount: normalizedEdits.length,
            ranges: normalizedEdits.map((edit) => edit.range),
            reasons: normalizedEdits.map((edit) => edit.reason),
            textPreview: normalizedEdits.map((edit) => edit.text).join("\n---\n").slice(0, 220),
          }),
        );
      }
      edits.push(
        ...normalizedEdits.map((edit) => ({
          range: edit.range,
          text: edit.text,
        })),
      );
    } else if (options.debug) {
      console.error(
        JSON.stringify({
          applied: "none",
          path: options.debugPath ?? request.path,
          cursor: request.cursor,
        }),
      );
    }
  }

  const response: ZedExternalResponse = { id, id_source: idSource, edits };
  if (cursorPredictionTarget) {
    response.jump = {
      path: cursorPredictionTarget.relativePath,
      expected_content: cursorPredictionTarget.expectedContent,
      should_retrigger: cursorPredictionTarget.shouldRetriggerCpp,
      position: {
        line: Math.max(0, cursorPredictionTarget.lineNumberOneIndexed - 1),
        column: 0,
      },
    };
  }

  return response;
}
