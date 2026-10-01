import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RelaySubmissionTracker,
  RelayTerminalError,
  RelayInFlightError,
  RelayOrderBusyError,
  RelayConfirmationTimeoutError,
  RelayTimeoutError,
  MemoryRelaySubmissionStore,
  computeSubmissionKey,
  computeOrderKey,
  type RelayAction,
  type RelayConfirmation,
  type RelayConfirmationRef,
  type RelayTrackerEvent,
  type StagedSubmission,
} from "../src/relay-submission-tracker.js";

/**
 * Every test in this file is a pure unit test: there is no Horizon server, no
 * JSON-RPC provider, and no live chain. The only network-shaped dependency the
 * tracker has is the injected `confirm` hook, which every test implements as a
 * local closure. `noNetworkAccess()` below asserts that explicitly.
 */

const noSleep = () => Promise.resolve();

const claim = (over: Partial<RelayAction> = {}): RelayAction => ({
  orderId: "order_123",
  side: "xlm_to_eth",
  action: "claim",
  chain: "ethereum",
  network: "sepolia",
  ...over,
});

const refund = (over: Partial<RelayAction> = {}): RelayAction => ({
  orderId: "order_123",
  side: "xlm_to_eth",
  action: "refund",
  chain: "stellar",
  network: "testnet",
  ...over,
});

/** A staged submission whose broadcast resolves, plus the spies to assert on. */
function staged(hash: string, result: unknown = { hash }): {
  stager: () => StagedSubmission<unknown>;
  broadcast: ReturnType<typeof vi.fn>;
} {
  const broadcast = vi.fn().mockResolvedValue(result);
  return {
    stager: () => ({ txHash: hash, network: "sepolia", broadcast }),
    broadcast,
  };
}

/** Confirm hook driven by a scripted list of states. */
function scriptedConfirm(states: RelayConfirmation["state"][]) {
  const calls: RelayConfirmationRef[] = [];
  let i = 0;
  const confirm = vi.fn(async (ref: RelayConfirmationRef): Promise<RelayConfirmation> => {
    calls.push(ref);
    const state = states[Math.min(i, states.length - 1)];
    i++;
    return state === "succeeded" ? { state, result: { hash: ref.txHash } } : { state };
  });
  return { confirm, calls };
}

function noNetworkAccess() {
  const fetchSpy = vi.fn(() => {
    throw new Error("the tracker must not touch the network directly");
  });
  const original = globalThis.fetch;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  return {
    fetchSpy,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/**
 * Hold on to a promise that is expected to stay pending (a broadcast that never
 * resolves) without leaking an unhandled rejection when the test tears down.
 */
function detach<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

describe("computeSubmissionKey / computeOrderKey", () => {
  it("is deterministic and keyed on order id, side and action only", () => {
    expect(computeSubmissionKey(claim())).toBe(computeSubmissionKey(claim()));
  });

  it("ignores amount, destination and extra so a re-priced attempt shares one slot", () => {
    const a = claim({ amount: "1.0", destination: "0xaaa", extra: { quote: 1 } });
    const b = claim({ amount: "1.0000001", destination: "0xbbb", extra: { quote: 2 } });
    // The old fingerprint included these fields, which forked one order into
    // two submissions whenever the amount was re-derived slightly differently.
    expect(computeSubmissionKey(a)).toBe(computeSubmissionKey(b));
  });

  it("separates different actions on the same order", () => {
    expect(computeSubmissionKey(claim())).not.toBe(computeSubmissionKey(refund()));
  });

  it("separates different sides of the same order id", () => {
    expect(computeSubmissionKey(claim({ side: "xlm_to_eth" }))).not.toBe(
      computeSubmissionKey(claim({ side: "eth_to_xlm" }))
    );
  });

  it("separates different orders", () => {
    expect(computeSubmissionKey(claim({ orderId: "order_123" }))).not.toBe(
      computeSubmissionKey(claim({ orderId: "order_999" }))
    );
  });

  it("keeps order ids apart even when sanitising would collapse them", () => {
    const weird = claim({ orderId: "a/b" });
    const other = claim({ orderId: "a_b" });
    expect(computeSubmissionKey(weird)).not.toBe(computeSubmissionKey(other));
    expect(computeOrderKey(weird.orderId, weird.side)).not.toBe(
      computeOrderKey(other.orderId, other.side)
    );
  });

  it("ignores chain and network in the key (they are recorded, not keyed on)", () => {
    expect(computeSubmissionKey(claim({ chain: "stellar", network: "testnet" }))).toBe(
      computeSubmissionKey(claim({ chain: "ethereum", network: "sepolia" }))
    );
  });
});

describe("single broadcast per submission (happy path)", () => {
  it("runs the stager once, broadcasts once, and records hash + network", async () => {
    const tracker = new RelaySubmissionTracker({ sleep: noSleep });
    const { stager, broadcast } = staged("0xhash");

    const outcome = await tracker.submit(claim(), stager);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.duplicate).toBe(false);
    expect(outcome.txHash).toBe("0xhash");
    expect(outcome.network).toBe("sepolia");

    const record = tracker.getRecord(claim());
    expect(record?.status).toBe("succeeded");
    expect(record?.txHash).toBe("0xhash");
    expect(record?.broadcasts).toBe(1);
  });

  it("returns the cached result for a duplicate without touching the chain again", async () => {
    const tracker = new RelaySubmissionTracker({ sleep: noSleep });
    const { stager, broadcast } = staged("0xhash", { hash: "0xhash" });

    const first = await tracker.submit(claim(), stager);
    const second = await tracker.submit(claim(), staged("0xother").stager);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("already_handled");
    expect(second.duplicate).toBe(true);
    expect(second.txHash).toBe("0xhash");
    expect(tracker.getStats().duplicatesSkipped).toBe(1);
  });
});

describe("hash, network and status are stored before the RPC returns", () => {
  it("persists the hash and a pending status before broadcast() is invoked", async () => {
    const store = new MemoryRelaySubmissionStore();
    const tracker = new RelaySubmissionTracker({ sleep: noSleep, store });

    let persistedAtBroadcastTime: { txHash?: string; status?: string; network?: string } = {};
    const broadcast = vi.fn(async () => {
      // Read the store from inside the broadcast, i.e. after the tracker has
      // handed us the hash but before the RPC has returned anything.
      const [entry] = store.load();
      persistedAtBroadcastTime = { txHash: entry?.txHash, status: entry?.status, network: entry?.network };
      return { hash: "0xhash" };
    });

    await tracker.submit(claim(), () => ({ txHash: "0xhash", network: "sepolia", broadcast }));

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(persistedAtBroadcastTime).toEqual({
      txHash: "0xhash",
      status: "pending",
      network: "sepolia",
    });
  });

  it("refuses to broadcast when the stager cannot name a hash", async () => {
    const tracker = new RelaySubmissionTracker({ sleep: noSleep });
    const broadcast = vi.fn();

    await expect(
      // @ts-expect-error deliberately violates the two-phase contract
      tracker.submit(claim(), () => ({ network: "sepolia", broadcast }))
    ).rejects.toBeInstanceOf(RelayTerminalError);

    expect(broadcast).not.toHaveBeenCalled();
    expect(tracker.getRecord(claim())?.status).toBe("failed");
  });
});

describe("acceptance: two overlapping claim attempts produce one hash", () => {
  it("collapses concurrent claims onto a single broadcast and a single hash", async () => {
    const { confirm } = scriptedConfirm(["succeeded"]);
    const tracker = new RelaySubmissionTracker({ sleep: noSleep, confirm });

    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const broadcast = vi.fn(async () => {
      await gate;
      return { hash: "0xsingle" };
    });
    const stager = vi.fn(() => ({ txHash: "0xsingle", network: "sepolia", broadcast }));

    const first = tracker.submit(claim(), stager);
    // Let the stager run and the hash be recorded before the second caller.
    await vi.waitFor(() => expect(tracker.getRecord(claim())?.txHash).toBe("0xsingle"));

    const second = tracker.submit(claim(), stager);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(stager).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(a.txHash).toBe("0xsingle");
    expect(b.txHash).toBe("0xsingle");
    // The waiter joined the running submission instead of starting its own.
    expect(b.duplicate).toBe(true);
    expect(a.duplicate).toBe(false);
    expect(tracker.getRecord(claim())?.broadcasts).toBe(1);
    expect(tracker.getStats().inFlightSkipped).toBe(1);
  });

  it("propagates the original failure to a joined caller rather than re-staging", async () => {
    const { confirm } = scriptedConfirm(["failed"]);
    const tracker = new RelaySubmissionTracker({ sleep: noSleep, maxAttempts: 2, confirm });
    const stager = vi.fn(() => ({
      txHash: "0xhash",
      broadcast: vi.fn(async () => {
        throw new Error("reverted");
      }),
    }));

    const first = tracker.submit(claim(), stager);
    const second = tracker.submit(claim(), stager);
    const results = await Promise.all([first.catch((e) => e), second.catch((e) => e)]);

    expect(stager).toHaveBeenCalledTimes(1);
    for (const result of results) expect(result).toBeInstanceOf(RelayTerminalError);
  });
});

describe("acceptance: a refund is refused while a claim is pending", () => {
  it("refuses a different action on the same order while the claim is unconfirmed", async () => {
    const tracker = new RelaySubmissionTracker({ timeoutMs: 10, sleep: noSleep });
    const refundStager = vi.fn(() => ({ txHash: "0xrefund", broadcast: vi.fn() }));

    const claimPromise = detach(
      tracker.submit(claim(), () => ({
        txHash: "0xclaim",
        network: "sepolia",
        broadcast: vi.fn(() => new Promise(() => {})),
      }))
    );
    await vi.waitFor(() => expect(tracker.getRecord(claim())?.status).toBe("pending"));

    const error = await tracker.submit(refund(), refundStager).catch((e) => e);

    expect(error).toBeInstanceOf(RelayOrderBusyError);
    // Also a RelayInFlightError so existing "relay busy" → HTTP 409 handling works.
    expect(error).toBeInstanceOf(RelayInFlightError);
    expect(error.blockingAction).toBe("claim");
    expect(error.requestedAction).toBe("refund");
    expect(error.message).toMatch(/refusing refund/i);
    expect(refundStager).not.toHaveBeenCalled();
    expect(tracker.getStats().orderBlocked).toBe(1);
  });

  it("refuses a claim while a refund is pending (the reverse direction)", async () => {
    const tracker = new RelaySubmissionTracker({ timeoutMs: 10, sleep: noSleep });
    const claimStager = vi.fn(() => ({ txHash: "0xclaim", broadcast: vi.fn() }));

    const refundPromise = detach(
      tracker.submit(refund(), () => ({
        txHash: "0xrefund",
        network: "testnet",
        broadcast: vi.fn(() => new Promise(() => {})),
      }))
    );
    await vi.waitFor(() => expect(tracker.getRecord(refund())?.status).toBe("pending"));

    await expect(tracker.submit(claim(), claimStager)).rejects.toBeInstanceOf(RelayOrderBusyError);
    expect(claimStager).not.toHaveBeenCalled();
  });

  it("refuses a refund after the claim has settled, so an order cannot pay out twice", async () => {
    const tracker = new RelaySubmissionTracker({ sleep: noSleep });
    const refundStager = vi.fn(() => ({ txHash: "0xrefund", broadcast: vi.fn() }));

    await tracker.submit(claim(), staged("0xclaim").stager);

    const error = await tracker.submit(refund(), refundStager).catch((e) => e);
    expect(error).toBeInstanceOf(RelayOrderBusyError);
    expect(error.message).toMatch(/already settled by claim/i);
    expect(refundStager).not.toHaveBeenCalled();
  });

  it("allows the refund once the claim failed terminally", async () => {
    const { confirm } = scriptedConfirm(["failed"]);
    const tracker = new RelaySubmissionTracker({ maxAttempts: 2, sleep: noSleep, confirm });

    await expect(
      tracker.submit(claim(), () => ({
        txHash: "0xclaim",
        network: "sepolia",
        broadcast: vi.fn(async () => {
          throw new Error("node unreachable");
        }),
      }))
    ).rejects.toBeInstanceOf(RelayTerminalError);
    expect(tracker.getRecord(claim())?.status).toBe("failed");

    // The order lock is released, so recovery can take over.
    const { stager, broadcast } = staged("0xrefund");
    const outcome = await tracker.submit(refund(), stager);
    expect(outcome.status).toBe("succeeded");
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("does not let one order block a different order or a different side", async () => {
    const tracker = new RelaySubmissionTracker({ timeoutMs: 10, sleep: noSleep });
    const pending = detach(
      tracker.submit(claim(), () => ({
        txHash: "0xclaim",
        network: "sepolia",
        broadcast: vi.fn(() => new Promise(() => {})),
      }))
    );
    await vi.waitFor(() => expect(tracker.getRecord(claim())?.status).toBe("pending"));

    // Different order id.
    await expect(
      tracker.submit(refund({ orderId: "order_999" }), staged("0xa").stager)
    ).resolves.toMatchObject({ status: "succeeded" });
    // Different side, same order id.
    await expect(
      tracker.submit(refund({ side: "eth_to_xlm" }), staged("0xb").stager)
    ).resolves.toMatchObject({ status: "succeeded" });
  });
});

describe("retries attach to the original hash instead of broadcasting again", () => {
  it("reconciles an ambiguous broadcast to success without a second broadcast", async () => {
    const { confirm, calls } = scriptedConfirm(["succeeded"]);
    const tracker = new RelaySubmissionTracker({ maxAttempts: 3, sleep: noSleep, confirm });
    const broadcast = vi.fn(() => Promise.reject(new Error("RPC timeout")));

    const outcome = await tracker.submit(claim(), () => ({
      txHash: "0xambiguous",
      network: "sepolia",
      broadcast,
    }));

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls[0].txHash).toBe("0xambiguous");
    expect(calls[0].network).toBe("sepolia");
    expect(outcome.status).toBe("succeeded");
    expect(outcome.reconciled).toBe(true);
    expect(tracker.getRecord(claim())?.broadcasts).toBe(1);
  });

  it("marks the submission terminally failed when the hash reverts on chain", async () => {
    const { confirm } = scriptedConfirm(["failed"]);
    const tracker = new RelaySubmissionTracker({ maxAttempts: 3, sleep: noSleep, confirm });
    const broadcast = vi.fn(() => Promise.reject(new Error("RPC timeout")));

    const error = await tracker
      .submit(claim(), () => ({ txHash: "0xreverted", network: "sepolia", broadcast }))
      .catch((e) => e);

    expect(error).toBeInstanceOf(RelayTerminalError);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(tracker.getRecord(claim())?.status).toBe("failed");
    // A later attempt must not broadcast again.
    await expect(
      tracker.submit(claim(), staged("0xagain").stager)
    ).rejects.toBeInstanceOf(RelayTerminalError);
  });

  it("keeps the order locked (and the record pending) when the budget runs out unconfirmed", async () => {
    const { confirm } = scriptedConfirm(["pending"]);
    const tracker = new RelaySubmissionTracker({ maxAttempts: 3, timeoutMs: 10, sleep: noSleep, confirm });
    const broadcast = vi.fn(() => new Promise(() => {}));
    const refundStager = vi.fn(() => ({ txHash: "0xrefund", broadcast: vi.fn() }));

    const error = await tracker
      .submit(claim(), () => ({ txHash: "0xlive", network: "sepolia", broadcast }))
      .catch((e) => e);

    expect(error).toBeInstanceOf(RelayConfirmationTimeoutError);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(tracker.getRecord(claim())?.status).toBe("pending");
    // Still locked: a refund must not race a possibly-live claim.
    await expect(tracker.submit(refund(), refundStager)).rejects.toBeInstanceOf(RelayOrderBusyError);
    expect(refundStager).not.toHaveBeenCalled();
  });

  it("resumes polling the stored hash on a later attempt instead of re-broadcasting", async () => {
    const confirm = vi.fn(async (ref: RelayConfirmationRef): Promise<RelayConfirmation> => {
      if (ref.txHash !== "0xlive") throw new Error("polled the wrong hash");
      return { state: "pending" };
    });
    const tracker = new RelaySubmissionTracker({ maxAttempts: 2, timeoutMs: 10, sleep: noSleep, confirm });
    const broadcast = vi.fn(() => new Promise(() => {}));
    const stager = vi.fn(() => ({ txHash: "0xlive", network: "sepolia", broadcast }));

    await expect(tracker.submit(claim(), stager)).rejects.toBeInstanceOf(
      RelayConfirmationTimeoutError
    );
    expect(broadcast).toHaveBeenCalledTimes(1);
    const attemptsAfterFirstCall = tracker.getRecord(claim())?.attempts;

    // The same order comes back later. The stored hash is polled again with a
    // fresh budget and the stager is never invoked a second time.
    confirm.mockResolvedValue({ state: "succeeded", result: { hash: "0xlive" } });
    const outcome = await tracker.submit(claim(), stager);

    expect(stager).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("already_handled");
    expect(outcome.duplicate).toBe(true);
    expect(outcome.txHash).toBe("0xlive");
    expect(confirm.mock.calls.every(([ref]) => ref.txHash === "0xlive")).toBe(true);
    expect(tracker.getRecord(claim())?.attempts).toBeGreaterThan(attemptsAfterFirstCall ?? 0);
  });

  it("fails terminally and releases the order when the hash is never observed", async () => {
    const { confirm } = scriptedConfirm(["not_found"]);
    const tracker = new RelaySubmissionTracker({ maxAttempts: 3, sleep: noSleep, confirm });
    const broadcast = vi.fn(() => Promise.reject(new Error("connection reset")));

    const error = await tracker
      .submit(claim(), () => ({ txHash: "0xghost", network: "sepolia", broadcast }))
      .catch((e) => e);

    expect(error).toBeInstanceOf(RelayTerminalError);
    expect((error as RelayTerminalError).reason).toBe("not_found");
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(tracker.getRecord(claim())?.status).toBe("failed");
    // The lock is released, so the refund path can rescue the user.
    await expect(tracker.submit(refund(), staged("0xrefund").stager)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("holds the order lock when no confirmer is configured", async () => {
    const tracker = new RelaySubmissionTracker({ sleep: noSleep, timeoutMs: 10 });
    const error = await tracker
      .submit(claim(), () => ({ txHash: "0xlive", broadcast: vi.fn(() => new Promise(() => {})) }))
      .catch((e) => e);
    expect(error).toBeInstanceOf(RelayConfirmationTimeoutError);
    await expect(tracker.submit(refund(), staged("0xrefund").stager)).rejects.toBeInstanceOf(
      RelayOrderBusyError
    );
  });
});

describe("staging, timeout and terminal-failure handling", () => {
  it("bounds the confirmation budget so a live-but-unknown hash cannot poll forever", async () => {
    const { confirm } = scriptedConfirm(["pending"]);
    const tracker = new RelaySubmissionTracker({ maxAttempts: 4, timeoutMs: 10, sleep: noSleep, confirm });
    const broadcast = vi.fn(() => new Promise(() => {}));

    await expect(
      tracker.submit(claim(), () => ({ txHash: "0xlive", broadcast }))
    ).rejects.toBeInstanceOf(RelayConfirmationTimeoutError);

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(4);
    expect(tracker.getRecord(claim())?.attempts).toBe(5);
  });

  it("fails terminally when staging itself fails, without broadcasting", async () => {
    const tracker = new RelaySubmissionTracker({ maxAttempts: 3, sleep: noSleep });
    const broadcast = vi.fn();

    await expect(
      tracker.submit(claim(), () => {
        throw new Error("INSUFFICIENT FUNDS");
      })
    ).rejects.toBeInstanceOf(RelayTerminalError);
    expect(broadcast).not.toHaveBeenCalled();
    expect(tracker.getRecord(claim())?.lastError).toMatch(/INSUFFICIENT/);
    expect(tracker.getRecord(claim())?.terminalReason).toBe("staging_failed");
  });

  it("honours a non-retryable staging failure as a tombstone", async () => {
    const tracker = new RelaySubmissionTracker({
      maxAttempts: 3,
      sleep: noSleep,
      isRetryable: () => false,
    });
    await expect(
      tracker.submit(claim(), () => {
        throw new Error("op_underfunded");
      })
    ).rejects.toBeInstanceOf(RelayTerminalError);
    expect(tracker.getRecord(claim())?.terminalReason).toBe("non_retryable");

    const stager = vi.fn(staged("0xhash").stager);
    await expect(tracker.submit(claim(), stager)).rejects.toBeInstanceOf(RelayTerminalError);
    expect(stager).not.toHaveBeenCalled();
  });

  it("re-stages after a pre-broadcast staging failure instead of tombstoning the order", async () => {
    const tracker = new RelaySubmissionTracker({ maxAttempts: 3, sleep: noSleep });

    // A transient Horizon/RPC hiccup while building the payment. Nothing was
    // signed or sent, so the slot must not be poisoned forever.
    await expect(
      tracker.submit(claim(), () => {
        throw new Error("ECONNRESET while loading the account");
      })
    ).rejects.toBeInstanceOf(RelayTerminalError);
    expect(tracker.getRecord(claim())?.terminalReason).toBe('staging_failed');

    const { stager, broadcast } = staged("0xhash");
    await expect(tracker.submit(claim(), stager)).resolves.toMatchObject({ status: "succeeded" });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("keeps a staging failure re-stageable across a restart", async () => {
    const store = new MemoryRelaySubmissionStore();
    const first = new RelaySubmissionTracker({ sleep: noSleep, store });
    await first
      .submit(claim(), () => {
        throw new Error("horizon timeout");
      })
      .catch(() => undefined);

    const restarted = new RelaySubmissionTracker({ sleep: noSleep, store });
    expect(restarted.getRecord(claim())?.terminalReason).toBe("staging_failed");
    await expect(restarted.submit(claim(), staged("0xhash").stager)).resolves.toMatchObject({
      status: "succeeded",
      txHash: "0xhash",
    });
  });

  it("does not re-stage once a hash exists, even if the transaction failed", async () => {
    const { confirm } = scriptedConfirm(["failed"]);
    const tracker = new RelaySubmissionTracker({ maxAttempts: 2, sleep: noSleep, confirm });
    await tracker
      .submit(claim(), () => ({ txHash: "0xdead", broadcast: vi.fn(() => Promise.reject(new Error("timeout"))) }))
      .catch(() => undefined);
    expect(tracker.getRecord(claim())?.terminalReason).toBe("failed");

    const stager = vi.fn(staged("0xsecond").stager);
    await expect(tracker.submit(claim(), stager)).rejects.toBeInstanceOf(RelayTerminalError);
    expect(stager).not.toHaveBeenCalled();
  });

  it("times out a hanging broadcast and reconciles the hash it already recorded", async () => {
    const { confirm } = scriptedConfirm(["succeeded"]);
    const tracker = new RelaySubmissionTracker({ maxAttempts: 2, timeoutMs: 10, sleep: noSleep, confirm });
    const broadcast = vi.fn(() => new Promise(() => {}));

    const outcome = await tracker.submit(claim(), () => ({ txHash: "0xslow", broadcast }));

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.txHash).toBe("0xslow");
  });

  it("treats a flaky confirmer as pending rather than as evidence", async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({ state: "succeeded" as const, result: { hash: "0xhash" } });
    const tracker = new RelaySubmissionTracker({ maxAttempts: 4, timeoutMs: 10, sleep: noSleep, confirm });

    const outcome = await tracker.submit(claim(), () => ({
      txHash: "0xhash",
      broadcast: vi.fn(() => new Promise(() => {})),
    }));

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("succeeded");
  });

  it("keeps RelayTimeoutError as its own type for the retry policy", () => {
    expect(new RelayTimeoutError("x")).toBeInstanceOf(Error);
  });
});

describe("acceptance: a confirmed hash is not resubmitted after restart", () => {
  it("rehydrates a settled record and serves it from cache", async () => {
    const store = new MemoryRelaySubmissionStore();
    const first = new RelaySubmissionTracker({ sleep: noSleep, store });
    await first.submit(claim(), staged("0xsaved", { hash: "0xsaved" }).stager);

    // Fresh process, same disk.
    const restarted = new RelaySubmissionTracker({ sleep: noSleep, store });
    expect(restarted.getStats().restored).toBe(1);
    expect(restarted.isHandled(claim())).toBe(true);

    const stager = vi.fn(() => ({ txHash: "0xnew", broadcast: vi.fn() }));
    const outcome = await restarted.submit(claim(), stager);

    expect(stager).not.toHaveBeenCalled();
    expect(outcome.status).toBe("already_handled");
    expect(outcome.duplicate).toBe(true);
    expect(outcome.txHash).toBe("0xsaved");
    expect(restarted.getRecord(claim())?.broadcasts).toBe(1);
  });

  it("rehydrates an unconfirmed hash as pending and polls it instead of broadcasting", async () => {
    const store = new MemoryRelaySubmissionStore();
    const first = new RelaySubmissionTracker({ timeoutMs: 10, sleep: noSleep, store });
    await first
      .submit(claim(), () => ({
        txHash: "0xinflight",
        network: "sepolia",
        broadcast: vi.fn(() => new Promise(() => {})),
      }))
      .catch(() => undefined);

    const { confirm, calls } = scriptedConfirm(["succeeded"]);
    const restarted = new RelaySubmissionTracker({ maxAttempts: 3, sleep: noSleep, store, confirm });

    expect(restarted.getRecord(claim())?.status).toBe("pending");
    expect(restarted.getRecord(claim())?.restored).toBe(true);

    const stager = vi.fn(() => ({ txHash: "0xnew", broadcast: vi.fn() }));
    const outcome = await restarted.submit(claim(), stager);

    expect(stager).not.toHaveBeenCalled();
    expect(calls[0].txHash).toBe("0xinflight");
    expect(outcome.txHash).toBe("0xinflight");
    expect(restarted.getRecord(claim())?.status).toBe("succeeded");
  });

  it("releases the order lock when the process died before any hash was recorded", async () => {
    // Simulate a hard crash: the key was reserved, the store still says
    // `in_flight`, and no hash was ever written.
    const key = computeSubmissionKey(claim());
    const store = new MemoryRelaySubmissionStore([
      {
        version: 1,
        key,
        orderKey: computeOrderKey(claim().orderId, claim().side),
        orderId: claim().orderId,
        side: claim().side,
        action: claim().action,
        chain: claim().chain,
        network: "sepolia",
        status: "in_flight",
        attempts: 1,
        maxAttempts: 3,
        broadcasts: 0,
        firstSeenAt: 1,
      },
    ]);

    const restarted = new RelaySubmissionTracker({ sleep: noSleep, store });
    // The two-phase contract guarantees nothing was broadcast without a
    // recorded hash, so the record is downgraded and the lock released.
    expect(restarted.getRecord(claim())?.status).toBe("failed");
    expect(restarted.getRecord(claim())?.lastError).toMatch(/before a transaction hash/i);
    expect(restarted.getBlockingRecord(refund())).toBeUndefined();
    await expect(restarted.submit(refund(), staged("0xrefund").stager)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("survives a store that cannot be written", async () => {
    const tracker = new RelaySubmissionTracker({
      sleep: noSleep,
      store: {
        load: () => [],
        save: () => {
          throw new Error("disk full");
        },
      },
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await expect(tracker.submit(claim(), staged("0xhash").stager)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(tracker.getStats().storeErrors).toBeGreaterThan(0);
  });
});

describe("forget / reset escape hatches", () => {
  it("refuses to forget a settled or pending record without an explicit override", async () => {
    const tracker = new RelaySubmissionTracker({ sleep: noSleep });
    await tracker.submit(claim(), staged("0xhash").stager);

    expect(tracker.forget(claim())).toBe(false);
    expect(tracker.isHandled(claim())).toBe(true);
    // Overriding is possible, but must be deliberate.
    expect(tracker.forget(claim(), { force: true })).toBe(true);
    expect(tracker.getRecord(claim())).toBeUndefined();
  });

  it("allows forgetting a terminally failed record so it can be retried", async () => {
    const tracker = new RelaySubmissionTracker({ maxAttempts: 1, sleep: noSleep });
    await expect(
      tracker.submit(claim(), () => {
        throw new Error("boom");
      })
    ).rejects.toBeInstanceOf(RelayTerminalError);

    expect(tracker.forget(claim())).toBe(true);
    await expect(tracker.submit(claim(), staged("0xhash").stager)).resolves.toMatchObject({
      status: "succeeded",
    });
  });

  it("clears everything on reset", async () => {
    const store = new MemoryRelaySubmissionStore();
    const tracker = new RelaySubmissionTracker({ sleep: noSleep, store });
    await tracker.submit(claim(), staged("0xhash").stager);
    tracker.reset();
    expect(tracker.getStats().tracked).toBe(0);
    expect(store.load()).toEqual([]);
  });
});

describe("observability", () => {
  it("emits a broadcast event carrying the hash and the order lock scope", async () => {
    const events: RelayTrackerEvent[] = [];
    const tracker = new RelaySubmissionTracker({
      sleep: noSleep,
      onEvent: (e) => events.push(e),
    });

    await tracker.submit(claim(), staged("0xhash").stager);

    const broadcastEvent = events.find((e) => e.type === "broadcast");
    expect(broadcastEvent?.txHash).toBe("0xhash");
    expect(broadcastEvent?.network).toBe("sepolia");
    expect(broadcastEvent?.orderKey).toBe(computeOrderKey(claim().orderId, claim().side));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["attempt", "broadcast", "success"])
    );
  });

  it("reports a single broadcast across all records in stats", async () => {
    const tracker = new RelaySubmissionTracker({ sleep: noSleep });
    await tracker.submit(claim(), staged("0xhash").stager);
    await tracker.submit(claim({ orderId: "order_999" }), staged("0xhash2").stager);

    const stats = tracker.getStats();
    expect(stats.tracked).toBe(2);
    expect(stats.succeeded).toBe(2);
    expect(stats.broadcasts).toBe(2);
    expect(stats.pendingConfirmations).toBe(0);
    expect(tracker.list()).toHaveLength(2);
  });
});

describe("no live chain is used", () => {
  let guard: ReturnType<typeof noNetworkAccess>;

  beforeEach(() => {
    guard = noNetworkAccess();
  });

  afterEach(() => {
    guard.restore();
  });

  it("completes a full claim + refund race without any network access", async () => {
    const { confirm } = scriptedConfirm(["succeeded"]);
    const store = new MemoryRelaySubmissionStore();
    const tracker = new RelaySubmissionTracker({ timeoutMs: 5_000, sleep: noSleep, store, confirm });

    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const claimPromise = detach(
      tracker.submit(claim(), () => ({
        txHash: "0xclaim",
        network: "sepolia",
        broadcast: vi.fn(async () => {
          await gate;
          return { hash: "0xclaim" };
        }),
      }))
    );
    await vi.waitFor(() => expect(tracker.getRecord(claim())?.status).toBe("pending"));

    const refused = await tracker.submit(refund(), staged("0xrefund").stager).catch((e) => e);
    expect(refused).toBeInstanceOf(RelayOrderBusyError);

    release();
    const claimOutcome = await claimPromise;
    expect(claimOutcome.txHash).toBe("0xclaim");

    // Restart with the same store: the settled claim is not resubmitted.
    const restarted = new RelaySubmissionTracker({ sleep: noSleep, store });
    await expect(restarted.submit(claim(), staged("0xother").stager)).resolves.toMatchObject({
      status: "already_handled",
      txHash: "0xclaim",
    });

    expect(guard.fetchSpy).not.toHaveBeenCalled();
  });
});
