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
      edits: [],
      jump: {
        path: "src/other.ts",
        expected_content: "const target = true;",
        should_retrigger: true,
        position: { line: 6, column: 0 },
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
});
