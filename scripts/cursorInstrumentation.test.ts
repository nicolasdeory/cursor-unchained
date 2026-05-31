import { describe, expect, test } from "bun:test";
import { patchText } from "./cursorInstrumentation";

const AE_ANCHOR = "getType(){return Object.getPrototypeOf(this).constructor}}}});";
const GE_ANCHOR = '}},_(U7h,"Message"),Ge=U7h,_(nXg,"makeMessageType"),';

describe("cursor instrumentation patcher", () => {
  test("patches stable protobuf runtime anchors exactly once", () => {
    const fixture = `prefix ${AE_ANCHOR} middle ${GE_ANCHOR} suffix`;
    const patched = patchText(fixture);

    expect(patched).toContain("__CURSOR_UNCHAINED_CPP_CAPTURE_V1__");
    expect(patched).toContain("aiserver.v1.StreamCppRequest");
    expect(patched).toContain("aiserver.v1.CppConfigResponse");
    expect(patched).toContain('globalThis.__cursorUnchainedPatchProto?.(ae,"ae")');
    expect(patched).toContain('globalThis.__cursorUnchainedPatchProto?.(Ge,"Ge")');
    expect(patchText(patched)).toBe(patched);
  });

  test("fails closed when Cursor changes the generated protobuf anchors", () => {
    expect(() => patchText("no anchors here")).toThrow(/protobuf .* anchor/i);
  });
});
