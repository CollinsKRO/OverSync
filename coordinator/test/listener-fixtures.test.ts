import { describe, it, expect } from "vitest";
import pino from "pino";
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService } from "../src/services/order-service.js";
import { ORDER_FAILURE_CODES } from "../src/state-machine/order-machine.js";
import { OrderEventApplier, type BridgeOrderEvent } from "../src/listeners/order-events.js";
import { decodeSorobanOrderEvent } from "../src/listeners/soroban-events.js";

const log = pino({ level: "silent" });

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const HASHLOCK = "0x" + "a".repeat(64);
const PREIMAGE = "0x" + "b".repeat(64);

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "oversync-listener-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

interface Harness {
  orders: OrderService;
  ethereum: OrderEventApplier;
  soroban: OrderEventApplier;
}

async function buildHarness(): Promise<Harness> {
  const db = await freshDb();
  const orders = new OrderService(new OrdersRepository(db), log);
  return {
    orders,
    ethereum: new OrderEventApplier(orders, log, "ethereum-listener"),
    soroban: new OrderEventApplier(orders, log, "soroban-listener")
  };
}

async function announce(
  orders: OrderService,
  direction: "eth_to_xlm" | "xlm_to_eth" = "eth_to_xlm",
  hashlock = HASHLOCK
) {
  const ethToXlm = direction === "eth_to_xlm";
  return orders.announce({
    direction,
    hashlock,
    srcChain: ethToXlm ? "ethereum" : "stellar",
    srcAddress: ethToXlm ? VALID_ETH_ADDR : VALID_STELLAR_ADDR,
    srcAsset: "native",
    srcAmount: "100",
    srcSafetyDeposit: "10",
    dstChain: ethToXlm ? "stellar" : "ethereum",
    dstAddress: ethToXlm ? VALID_STELLAR_ADDR : VALID_ETH_ADDR,
    dstAsset: "native",
    dstAmount: "100"
  });
}

const lockEvent = (
  chain: "ethereum" | "stellar",
  overrides: Partial<BridgeOrderEvent> = {}
): BridgeOrderEvent => ({
  kind: "lock",
  chain,
  txHash: `0x${chain}-lock`,
  blockNumber: 100,
  orderId: "1",
  hashlock: HASHLOCK,
  timelock: 10_000,
  ...overrides
});

describe("OrderEventApplier — chain event fixtures (no live chain)", () => {
  it("advances an eth->xlm order from escrow to the resolver's destination lock", async () => {
    const { orders, ethereum } = await buildHarness();
    const order = await announce(orders);

    expect(
      await ethereum.apply(lockEvent("ethereum", { txHash: "0xeth-lock" }))
    ).toEqual({ status: "applied", publicId: order.publicId });
    expect(
      await ethereum.apply(
        lockEvent("stellar", { txHash: "0xstellar-lock", orderId: "77", timelock: 9_000 })
      )
    ).toEqual({ status: "applied", publicId: order.publicId });

    const stored = await orders.get(order.publicId);
    expect(stored!.status).toBe("dst_locked");
    expect(stored!.srcOrderId).toBe("1");
    expect(stored!.dstOrderId).toBe("77");
    expect((await orders.getTransitions(order.publicId)).map((t) => t.to)).toEqual([
      "announced",
      "src_locked",
      "dst_locked"
    ]);
  });

  it("reads a lock on the order's destination chain as the destination leg", async () => {
    const { orders, soroban } = await buildHarness();
    const order = await announce(orders, "xlm_to_eth", "0x" + "c".repeat(64));

    // Source leg on Stellar, resolved by hashlock.
    await soroban.apply(
      lockEvent("stellar", { hashlock: order.hashlock, txHash: "0xst-src", timelock: 10_000 })
    );
    // Destination leg on Ethereum: the same event shape, a different edge.
    await soroban.apply(
      lockEvent("ethereum", {
        hashlock: order.hashlock,
        txHash: "0xeth-dst",
        orderId: "42",
        timelock: 9_000
      })
    );

    const stored = await orders.get(order.publicId);
    expect(stored!.status).toBe("dst_locked");
    expect(stored!.srcLockTx).toBe("0xst-src");
    expect(stored!.dstLockTx).toBe("0xeth-dst");
  });

  it("refuses a destination lock that arrives before the escrow", async () => {
    const { orders, soroban } = await buildHarness();
    const order = await announce(orders);

    const outcome = await soroban.apply(
      lockEvent("stellar", { hashlock: order.hashlock, orderId: "9", timelock: 9_000 })
    );

    expect(outcome).toMatchObject({
      status: "rejected",
      code: ORDER_FAILURE_CODES.SECRET_RELAY_BEFORE_ESCROW
    });
    expect((await orders.get(order.publicId))!.status).toBe("announced");
    const rejected = await orders.getRejectedTransitions(order.publicId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      writer: "soroban-listener",
      action: "secret_relay",
      from: "announced",
      to: "dst_locked"
    });
  });

  it("refuses a claim that arrives before the preimage is known", async () => {
    const { orders, ethereum } = await buildHarness();
    const order = await announce(orders);
    await ethereum.apply(lockEvent("ethereum"));
    await ethereum.apply(lockEvent("stellar", { orderId: "5", timelock: 9_000 }));

    const outcome = await ethereum.apply({
      kind: "claim",
      chain: "ethereum",
      txHash: "0xclaim",
      blockNumber: 300,
      orderId: "1",
      preimage: null
    });

    expect(outcome).toMatchObject({
      status: "rejected",
      code: ORDER_FAILURE_CODES.CLAIM_BEFORE_SECRET
    });
    expect((await orders.get(order.publicId))!.status).toBe("dst_locked");
    expect((await orders.getRejectedTransitions(order.publicId))[0]).toMatchObject({
      writer: "ethereum-listener",
      action: "claim",
      code: ORDER_FAILURE_CODES.CLAIM_BEFORE_SECRET
    });
  });

  it("applies a claim event that carries the preimage, once", async () => {
    const { orders, ethereum } = await buildHarness();
    const order = await announce(orders);
    await ethereum.apply(lockEvent("ethereum"));
    await ethereum.apply(lockEvent("stellar", { orderId: "5", timelock: 9_000 }));

    const claim = {
      kind: "claim" as const,
      chain: "ethereum" as const,
      txHash: "0xclaim",
      blockNumber: 300,
      orderId: "1",
      preimage: PREIMAGE
    };
    await ethereum.apply(claim);
    // The Ethereum order id is the source leg; a redelivery of the same claim
    // must not settle it twice.
    await ethereum.apply(claim);

    const stored = await orders.get(order.publicId);
    expect(stored!.status).toBe("completed");
    expect(stored!.preimage).toBe(PREIMAGE);
    expect((await orders.getTransitions(order.publicId)).map((t) => t.to)).toEqual([
      "announced",
      "src_locked",
      "dst_locked",
      "secret_revealed",
      "completed"
    ]);
    const rejected = await orders.getRejectedTransitions(order.publicId);
    expect(rejected.map((r) => r.code)).toEqual([ORDER_FAILURE_CODES.REPEATED_STEP]);
  });

  it("refuses a refund after the order was claimed", async () => {
    const { orders, ethereum } = await buildHarness();
    const order = await announce(orders);
    await ethereum.apply(lockEvent("ethereum"));
    await ethereum.apply(lockEvent("stellar", { orderId: "5", timelock: 9_000 }));
    await ethereum.apply({
      kind: "claim",
      chain: "ethereum",
      txHash: "0xclaim",
      blockNumber: 300,
      orderId: "1",
      preimage: PREIMAGE
    });

    const outcome = await ethereum.apply({
      kind: "refund",
      chain: "stellar",
      txHash: "0xrefund",
      blockNumber: 400,
      orderId: "5"
    });

    expect(outcome).toMatchObject({
      status: "rejected",
      code: ORDER_FAILURE_CODES.REFUND_AFTER_CLAIM
    });
    expect((await orders.get(order.publicId))!.status).toBe("completed");
  });

  it("applies a refund on a locked order", async () => {
    const { orders, soroban } = await buildHarness();
    const order = await announce(orders);
    await soroban.apply(lockEvent("ethereum"));
    await soroban.apply(lockEvent("stellar", { orderId: "5", timelock: 9_000 }));

    const outcome = await soroban.apply({
      kind: "refund",
      chain: "stellar",
      txHash: "0xrefund",
      blockNumber: 400,
      orderId: "5"
    });

    expect(outcome).toEqual({ status: "applied", publicId: order.publicId });
    expect((await orders.get(order.publicId))!.status).toBe("refunded");
  });

  it("refuses a conflicting re-lock and keeps the escrow in place", async () => {
    const { orders, ethereum } = await buildHarness();
    const order = await announce(orders);
    await ethereum.apply(lockEvent("ethereum"));

    // A reorg hands us the same escrow step from a different transaction.
    const outcome = await ethereum.apply(
      lockEvent("ethereum", { txHash: "0xreorg-lock", blockNumber: 999 })
    );

    expect(outcome).toMatchObject({
      status: "rejected",
      code: ORDER_FAILURE_CODES.CONFLICTING_STEP
    });
    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
    expect((await orders.get(order.publicId))!.srcLockTx).toBe("0xethereum-lock");
  });

  it("refuses a re-lock that arrives after the order moved on", async () => {
    const { orders, ethereum } = await buildHarness();
    const order = await announce(orders);
    await ethereum.apply(lockEvent("ethereum"));
    await ethereum.apply(lockEvent("stellar", { orderId: "5", timelock: 9_000 }));

    const outcome = await ethereum.apply(
      lockEvent("ethereum", { txHash: "0xlate-lock", blockNumber: 999 })
    );

    expect(outcome).toMatchObject({
      status: "rejected",
      code: ORDER_FAILURE_CODES.LATE_STEP
    });
    expect((await orders.get(order.publicId))!.status).toBe("dst_locked");
    expect((await orders.get(order.publicId))!.srcLockTx).toBe("0xethereum-lock");
  });

  it("ignores events for orders it does not track", async () => {
    const { orders, ethereum } = await buildHarness();
    const order = await announce(orders);

    expect(
      await ethereum.apply(lockEvent("ethereum", { hashlock: "0x" + "9".repeat(64) }))
    ).toMatchObject({ status: "ignored" });
    expect(
      await ethereum.apply({
        kind: "claim",
        chain: "ethereum",
        txHash: "0xc",
        blockNumber: 1,
        orderId: "123456"
      })
    ).toMatchObject({ status: "ignored" });
    expect(await orders.getRejectedTransitions(order.publicId)).toEqual([]);
    expect((await orders.get(order.publicId))!.status).toBe("announced");
  });

  it("ignores lock events without a hashlock or a timelock", async () => {
    const { orders, ethereum } = await buildHarness();
    const order = await announce(orders);

    expect(
      await ethereum.apply(lockEvent("ethereum", { hashlock: null }))
    ).toMatchObject({ status: "ignored" });
    expect(
      await ethereum.apply(lockEvent("ethereum", { timelock: null }))
    ).toMatchObject({ status: "ignored" });
    expect((await orders.get(order.publicId))!.status).toBe("announced");
  });
});

// ─── Soroban event decoding ───────────────────────────────────────────────
//
// The fixtures mirror the events published by `soroban/contracts/htlc`:
//   created  (sender, beneficiary, hashlock) + (order_id, asset, amount, safety_deposit, timelock)
//   claimed  (beneficiary, hashlock)         + (order_id, caller, preimage, amount, safety_deposit)
//   refunded (refund_address, hashlock)      + (order_id, caller, amount, safety_deposit)

/** A checksum-valid Stellar account for the event topics we ignore. */
const SOROBAN_ACCOUNT = Keypair.random().publicKey();

const scAddress = () => new Address(SOROBAN_ACCOUNT).toScVal();
const scSymbol = (name: string) => nativeToScVal(name, { type: "symbol" });
const scBytes = (hex: string) => nativeToScVal(Buffer.from(hex.slice(2), "hex"));
const scU64 = (value: number | bigint) => nativeToScVal(BigInt(value), { type: "u64" });
const encode = (scVal: xdr.ScVal) => scVal.toXDR("base64");

/** Encode topics and data the way the RPC returns them: base64 XDR. */
const sorobanEvent = (topic: xdr.ScVal[], value: xdr.ScVal) => ({
  topic: topic.map(encode),
  value: encode(value),
  txHash: "soroban-tx",
  ledger: 42
});

describe("decodeSorobanOrderEvent", () => {
  it("decodes a created (lock) event", () => {
    const decoded = decodeSorobanOrderEvent(
      sorobanEvent(
        [scSymbol("created"), scAddress(), scAddress(), scBytes(HASHLOCK)],
        nativeToScVal([
          scU64(7),
          nativeToScVal("native"),
          nativeToScVal(1000n),
          nativeToScVal(10n),
          scU64(1_700_000_000)
        ])
      )
    );

    expect(decoded).toEqual({
      kind: "lock",
      chain: "stellar",
      txHash: "soroban-tx",
      blockNumber: 42,
      hashlock: HASHLOCK,
      orderId: "7",
      timelock: 1_700_000_000
    });
  });

  it("decodes a claimed event, preimage included", () => {
    const decoded = decodeSorobanOrderEvent(
      sorobanEvent(
        [scSymbol("claimed"), scAddress(), scBytes(HASHLOCK)],
        nativeToScVal([
          scU64(7),
          scAddress(),
          scBytes(PREIMAGE),
          nativeToScVal(1000n),
          nativeToScVal(10n)
        ])
      )
    );

    expect(decoded).toEqual({
      kind: "claim",
      chain: "stellar",
      txHash: "soroban-tx",
      blockNumber: 42,
      hashlock: HASHLOCK,
      orderId: "7",
      preimage: PREIMAGE
    });
  });

  it("decodes a refunded event", () => {
    const decoded = decodeSorobanOrderEvent(
      sorobanEvent(
        [scSymbol("refunded"), scAddress(), scBytes(HASHLOCK)],
        nativeToScVal([scU64(7), scAddress(), nativeToScVal(1000n), nativeToScVal(10n)])
      )
    );

    expect(decoded).toMatchObject({ kind: "refund", orderId: "7", hashlock: HASHLOCK });
    expect(decoded).not.toHaveProperty("preimage");
  });

  it("accepts already parsed ScVals as well as base64", () => {
    const decoded = decodeSorobanOrderEvent({
      topic: [scSymbol("refunded"), scAddress(), scBytes(HASHLOCK)],
      value: nativeToScVal([
        scU64(9),
        scAddress(),
        nativeToScVal(1000n),
        nativeToScVal(10n)
      ]),
      txHash: "soroban-tx-2",
      ledger: 7
    });

    expect(decoded).toMatchObject({ kind: "refund", orderId: "9", blockNumber: 7 });
  });

  it("ignores unrelated or undecodable events", () => {
    expect(
      decodeSorobanOrderEvent(
        sorobanEvent([scSymbol("transfer")], nativeToScVal([scU64(7), nativeToScVal(1000n)]))
      )
    ).toBeNull();
    expect(
      decodeSorobanOrderEvent(sorobanEvent([nativeToScVal(7)], nativeToScVal([scU64(7)])))
    ).toBeNull();
    expect(
      decodeSorobanOrderEvent({
        topic: ["not-base64"],
        value: "also-not-base64",
        txHash: "t",
        ledger: 1
      })
    ).toBeNull();
  });

  it("feeds decoded Soroban events through the same machine as the EVM path", async () => {
    const { orders, soroban } = await buildHarness();
    const order = await announce(orders, "eth_to_xlm", HASHLOCK);

    // A Soroban `claimed` event for an order that has not been escrowed yet.
    const decoded = decodeSorobanOrderEvent(
      sorobanEvent(
        [scSymbol("claimed"), scAddress(), scBytes(HASHLOCK)],
        nativeToScVal([
          scU64(7),
          scAddress(),
          scBytes(PREIMAGE),
          nativeToScVal(1000n),
          nativeToScVal(10n)
        ])
      )
    );
    expect(decoded).not.toBeNull();

    const outcome = await soroban.apply(decoded!);
    expect(outcome).toMatchObject({
      status: "rejected",
      code: ORDER_FAILURE_CODES.SECRET_BEFORE_ESCROW
    });
    expect((await orders.get(order.publicId))!.status).toBe("announced");
    expect((await orders.getRejectedTransitions(order.publicId))[0]).toMatchObject({
      writer: "soroban-listener",
      code: ORDER_FAILURE_CODES.SECRET_BEFORE_ESCROW
    });
  });
});
