import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileRelaySubmissionStore,
  MemoryRelaySubmissionStore,
  STORE_SCHEMA_VERSION,
  type PersistedSubmission,
} from "../src/relay-submission-store.js";

function entry(over: Partial<PersistedSubmission> = {}): PersistedSubmission {
  return {
    version: STORE_SCHEMA_VERSION,
    key: "xlm_to_eth:claim:order_1#abcd1234",
    orderKey: "order_1|xlm_to_eth#abcd1234",
    orderId: "order_1",
    side: "xlm_to_eth",
    action: "claim",
    chain: "ethereum",
    network: "sepolia",
    txHash: "0xabc",
    status: "pending",
    attempts: 2,
    maxAttempts: 3,
    broadcasts: 1,
    firstSeenAt: 1_000,
    ...over,
  };
}

describe("MemoryRelaySubmissionStore", () => {
  it("round-trips records without aliasing the caller's objects", () => {
    const store = new MemoryRelaySubmissionStore([entry()]);
    const loaded = store.load();
    loaded[0].status = "failed";
    expect(store.load()[0].status).toBe("pending");
  });
});

describe("FileRelaySubmissionStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-submission-store-"));
    filePath = join(dir, "submissions.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty set when nothing has been written yet", () => {
    expect(new FileRelaySubmissionStore({ filePath }).load()).toEqual([]);
  });

  it("writes atomically and leaves no temp file behind", () => {
    const store = new FileRelaySubmissionStore({ filePath });
    store.save([entry()]);

    expect(store.load()).toEqual([entry()]);
    const raw = readFileSync(filePath, "utf8");
    expect(JSON.parse(raw).version).toBe(STORE_SCHEMA_VERSION);
    expect(JSON.parse(raw).submissions).toHaveLength(1);
    expect(raw.endsWith("\n")).toBe(true);
    expect(readdirSync(dir)).toEqual(["submissions.json"]);
  });

  it("creates missing parent directories", () => {
    const nested = new FileRelaySubmissionStore({ filePath: join(dir, "a", "b", "submissions.json") });
    nested.save([entry()]);
    expect(nested.load()).toEqual([entry()]);
  });

  it("replaces the previous snapshot instead of appending", () => {
    const store = new FileRelaySubmissionStore({ filePath });
    store.save([entry(), entry({ key: "k2", orderId: "order_2" })]);
    store.save([entry()]);
    expect(store.load().map(e => e.key)).toEqual([entry().key]);
  });

  it("treats a corrupt file as empty instead of refusing to start", () => {
    writeFileSync(filePath, "{not json", "utf8");
    const errors: string[] = [];
    const store = new FileRelaySubmissionStore({
      filePath,
      logger: { log: () => {}, warn: () => {}, error: (m: unknown) => errors.push(String(m)) },
    });
    expect(store.load()).toEqual([]);
    expect(errors.join(" ")).toMatch(/not valid JSON/i);
  });

  it("treats an empty file as an empty set", () => {
    writeFileSync(filePath, "   \n", "utf8");
    expect(new FileRelaySubmissionStore({ filePath }).load()).toEqual([]);
  });

  it("ignores entries without a key and tolerates a bare array", () => {
    writeFileSync(filePath, JSON.stringify([entry(), { nope: true }]), "utf8");
    expect(new FileRelaySubmissionStore({ filePath }).load()).toHaveLength(1);
  });

  it("reports an unexpected shape instead of guessing", () => {
    writeFileSync(filePath, JSON.stringify({ somethingElse: true }), "utf8");
    const errors: string[] = [];
    const store = new FileRelaySubmissionStore({
      filePath,
      logger: { log: () => {}, warn: () => {}, error: (m: unknown) => errors.push(String(m)) },
    });
    expect(store.load()).toEqual([]);
    expect(errors.join(" ")).toMatch(/unexpected shape/i);
  });

  it("keeps every non-terminal record and prunes only old terminal ones", () => {
    const store = new FileRelaySubmissionStore({ filePath, maxRecords: 2 });
    store.save([
      // Two live submissions: these hold order locks and must never be pruned.
      entry({ key: "live-1", status: "in_flight", txHash: undefined, completedAt: undefined }),
      entry({ key: "live-2", status: "pending" }),
      entry({ key: "old-1", status: "failed", completedAt: 10 }),
      entry({ key: "old-2", status: "succeeded", completedAt: 20 }),
      entry({ key: "new-1", status: "succeeded", completedAt: 30 }),
    ]);

    const keys = store.load().map(e => e.key);
    expect(keys).toContain("live-1");
    expect(keys).toContain("live-2");
    // Newest two terminal records survive.
    expect(keys).toContain("new-1");
    expect(keys).toContain("old-2");
    expect(keys).not.toContain("old-1");
  });

  it("surfaces a write failure to the caller so the tracker can count it", () => {
    // A file where a parent directory is expected makes mkdir fail.
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory", "utf8");
    const errors: string[] = [];
    const store = new FileRelaySubmissionStore({
      filePath: join(blocker, "submissions.json"),
      logger: { log: () => {}, warn: () => {}, error: (m: unknown) => errors.push(String(m)) },
    });

    expect(() => store.save([entry()])).toThrow();
    expect(errors.join(" ")).toMatch(/could not write/i);
  });
});
