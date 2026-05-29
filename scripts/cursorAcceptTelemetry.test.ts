import { describe, expect, test } from "bun:test";
import {
  buildRecordCppAcceptFateEnvelope,
  buildRecordCppAcceptFateProto,
  buildRecordCppFateProto,
  extensionForPath,
} from "./cursorAcceptTelemetry";

describe("Cursor accept telemetry", () => {
  test("extracts short file extensions from relative paths", () => {
    expect(extensionForPath("src/app.ts")).toBe("ts");
    expect(extensionForPath("src/archive.test.tsx")).toBe("tsx");
    expect(extensionForPath("Makefile")).toBe("");
    expect(extensionForPath("src/file.generatedextension")).toBe("");
  });

  test("encodes RecordCppFate accept requests as Connect envelopes", () => {
    const envelope = buildRecordCppAcceptFateEnvelope(
      {
        requestId: "request-123",
        extension: "ts",
      },
      12.5,
    );

    expect(envelope[0]).toBe(0);
    expect(envelope.readUInt32BE(1)).toBe(envelope.length - 5);
    expect(envelope.subarray(5).length).toBeGreaterThan(0);
  });

  test("encodes raw RecordCppFate protobuf for Cursor's unary endpoint", () => {
    const raw = buildRecordCppAcceptFateProto(
      {
        requestId: "request-123",
        extension: "ts",
      },
      12.5,
    );

    expect(raw.length).toBeGreaterThan(0);
    expect(raw[0]).not.toBe(0);
  });

  test("encodes distinct Cursor fate values", () => {
    const metadata = {
      requestId: "request-123",
      extension: "ts",
    };

    expect(buildRecordCppFateProto(metadata, "accept", 12.5)).not.toEqual(
      buildRecordCppFateProto(metadata, "reject", 12.5),
    );
    expect(buildRecordCppFateProto(metadata, "partial_accept", 12.5)).not.toEqual(
      buildRecordCppFateProto(metadata, "reject", 12.5),
    );
  });
});
