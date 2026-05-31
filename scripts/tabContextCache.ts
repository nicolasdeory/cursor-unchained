import crypto from "node:crypto";

export type TabContextCacheInput = {
  workspaceId: string;
  relativeWorkspacePath: string;
  line: number;
  column: number;
  contents: string;
};

type TabContextCacheEntry = {
  fetchedAt: number;
  codeResults: any[];
};

export type TabContextCacheHit = {
  source: "exact" | "file";
  codeResults: any[];
};

export function tabContextCacheInput(args: {
  workspaceId?: unknown;
  relativeWorkspacePath?: unknown;
  line?: unknown;
  column?: unknown;
  contents?: unknown;
}): TabContextCacheInput {
  return {
    workspaceId: typeof args.workspaceId === "string" ? args.workspaceId : "",
    relativeWorkspacePath:
      typeof args.relativeWorkspacePath === "string" ? args.relativeWorkspacePath : "",
    line: typeof args.line === "number" && Number.isFinite(args.line) ? args.line : 0,
    column:
      typeof args.column === "number" && Number.isFinite(args.column) ? args.column : 0,
    contents: typeof args.contents === "string" ? args.contents : "",
  };
}

export function exactTabContextCacheKey(input: TabContextCacheInput) {
  const digest = crypto.createHash("sha256").update(input.contents).digest("hex").slice(0, 16);
  return [
    input.workspaceId,
    input.relativeWorkspacePath,
    input.line,
    input.column,
    digest,
  ].join(":");
}

export function fileTabContextCacheKey(input: TabContextCacheInput) {
  return [input.workspaceId, input.relativeWorkspacePath].join(":");
}

export class TabContextCache {
  private exactEntries = new Map<string, TabContextCacheEntry>();
  private fileEntries = new Map<string, TabContextCacheEntry>();

  constructor(private maxEntries = 100) {}

  get(
    input: TabContextCacheInput,
    ttlMs: number,
    now = Date.now(),
  ): TabContextCacheHit | null {
    const exact = this.freshEntry(this.exactEntries.get(exactTabContextCacheKey(input)), ttlMs, now);
    if (exact) {
      return { source: "exact", codeResults: exact.codeResults };
    }

    const file = this.freshEntry(this.fileEntries.get(fileTabContextCacheKey(input)), ttlMs, now);
    if (file) {
      return { source: "file", codeResults: file.codeResults };
    }

    return null;
  }

  set(input: TabContextCacheInput, codeResults: any[], fetchedAt = Date.now()) {
    const entry = { fetchedAt, codeResults };
    this.exactEntries.set(exactTabContextCacheKey(input), entry);
    this.fileEntries.set(fileTabContextCacheKey(input), entry);
    this.prune(this.exactEntries);
    this.prune(this.fileEntries);
  }

  private freshEntry(
    entry: TabContextCacheEntry | undefined,
    ttlMs: number,
    now: number,
  ) {
    if (!entry || now - entry.fetchedAt >= ttlMs) {
      return null;
    }

    return entry;
  }

  private prune(entries: Map<string, TabContextCacheEntry>) {
    while (entries.size > this.maxEntries) {
      const oldest = entries.keys().next().value;
      if (!oldest) {
        return;
      }
      entries.delete(oldest);
    }
  }
}
