import { describe, expect, test } from "bun:test";
import { toZedResponse, type ZedRequestForProtocol } from "./zedExternalProtocol";

function request(contents: string, line = 0, column = 0): ZedRequestForProtocol {
  return {
    path: "src/test.ts",
    contents,
    cursor: { line, column },
  };
}

describe("toZedResponse", () => {
  test("uses Cursor binding ids as stable Zed prediction ids", () => {
    const response = toZedResponse(request("function add(a: number, b: number) {\n  return \n}\n", 1, 9), {
      bindingId: "cursor-binding-123",
      text: "  return a + b;\n",
    });

    expect(response.id).toBe("cursor-binding-123");
    expect(response.id_source).toBe("cursor");
    expect(response.edits.length).toBeGreaterThan(0);
  });

  test("converts Cursor prediction targets into Zed jumps", () => {
    const response = toZedResponse(request("export function main() {}\n"), {
      bindingId: "jump-binding-123",
      text: "",
      cursorPredictionTarget: {
        relativePath: "src/other.ts",
        lineNumberOneIndexed: 7,
        expectedContent: "const target = true;",
        shouldRetriggerCpp: true,
      },
    });

    expect(response).toEqual({
      id: "jump-binding-123",
      id_source: "cursor",
      edits: [],
      jump: {
        path: "src/other.ts",
        expected_content: "const target = true;",
        should_retrigger: true,
        position: { line: 6, column: 0 },
      },
    });
  });

  test("prefers Cursor prediction targets over local text edits", () => {
    const response = toZedResponse(request("export function main() {\n  return \n}\n", 1, 9), {
      bindingId: "jump-binding-with-text",
      text: "  return 1;\n",
      cursorPredictionTarget: {
        relativePath: "src/other.ts",
        lineNumberOneIndexed: 3,
        expectedContent: "export const target = 1;",
      },
    });

    expect(response).toEqual({
      id: "jump-binding-with-text",
      id_source: "cursor",
      edits: [],
      jump: {
        path: "src/other.ts",
        expected_content: "export const target = 1;",
        should_retrigger: undefined,
        position: { line: 2, column: 0 },
      },
    });
  });

  test("clamps malformed one-indexed jump lines to the start of the file", () => {
    const response = toZedResponse(request("export function main() {}\n"), {
      text: "",
      cursorPredictionTarget: {
        relativePath: "src/other.ts",
        lineNumberOneIndexed: 0,
      },
    });

    expect(response.jump?.position).toEqual({ line: 0, column: 0 });
  });

  test("marks generated ids as synthetic when Cursor does not send a binding id", () => {
    const response = toZedResponse(request("let value = \n", 0, 12), {
      text: "1",
    });

    expect(response.id).toBeTruthy();
    expect(response.id_source).toBe("synthetic");
  });
});
