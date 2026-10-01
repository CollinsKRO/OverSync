import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService, OrderTransitionRejectedError, StaleOrderEventError } from "../src/services/order-service.js";
import { ORDER_FAILURE_CODES } from "../src/state-machine/order-machine.js";
import { ordersRoutes } from "../src/server/routes/orders.js";

const log = pino({ level: "silent" });
const VALID_HASHLOCK = "0x" + "a".repeat(64);
const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const PREIMAGE = "0x" + "d".repeat(64);

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "oversync-transition-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

function buildOrderService(db: Awaited<ReturnType<typeof freshDb>>) {
  return new OrderService(new OrdersRepository(db), log);
}

function buildApp(orders: OrderService) {
  const app = express();
  app.use(express.json());
  app.use("/api", ordersRoutes(orders));
  return app;
}

describe("OrderService transition summaries", () => {
  it("returns happy-path transitions without leaking preimage values", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);

    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK,
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1000000000000000000",
      srcSafetyDeposit: "1000000000000000",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "100000000"
    });

    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-1",
      txHash: "0xsrc",
      blockNumber: 1,
      timelock: 10_000
    });
    await orders.recordDstLock({
      publicId: order.publicId,
      orderId: "dst-1",
      txHash: "0xdst",
      blockNumber: 2,
      timelock: 9_000,
      resolver: null
    });
    await orders.recordSecret(order.publicId, PREIMAGE, "0xsecret");

    const transitions = await orders.getTransitions(order.publicId);

    expect(transitions.map((transition) => transition.to)).toEqual([
      "announced",
      "src_locked",
      "dst_locked",
      "secret_revealed"
    ]);
    expect(transitions[0]).toMatchObject({ from: null, to: "announced", category: "created", txHash: null });
    expect(transitions[3]).toMatchObject({ from: "dst_locked", to: "secret_revealed", category: "secret_revealed", txHash: "0xsecret" });
    expect(JSON.stringify(transitions)).not.toContain("preimage");
    expect(JSON.stringify(transitions)).not.toContain(PREIMAGE);
  });

  it("returns refund-path transitions for refunded orders", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);

    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: "0x" + "b".repeat(64),
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1",
      srcSafetyDeposit: "1",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "1"
    });

    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-2",
      txHash: "0xsrc2",
      blockNumber: 3,
      timelock: 3000
    });
    await orders.markStatus(order.publicId, "refunded");

    const transitions = await orders.getTransitions(order.publicId);

    expect(transitions.map((transition) => transition.to)).toEqual([
      "announced",
      "src_locked",
      "refunded"
    ]);
    expect(transitions[2]).toMatchObject({ from: "src_locked", to: "refunded", category: "refunded", txHash: null });
  });
});

describe("GET /api/orders/:id/transitions", () => {
  it("returns happy-path transition history without exposing secret fields", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const app = buildApp(orders);

    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: VALID_HASHLOCK,
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "100",
      srcSafetyDeposit: "10",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "100"
    });

    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-3",
      txHash: "0xsrc3",
      blockNumber: 4,
      timelock: 10_000
    });
    await orders.recordDstLock({
      publicId: order.publicId,
      orderId: "dst-3",
      txHash: "0xdst3",
      blockNumber: 5,
      timelock: 9_000,
      resolver: null
    });
    await orders.recordSecret(order.publicId, PREIMAGE, "0xsecret3");

    const res = await request(app).get(`/api/orders/${order.publicId}/transitions`).expect(200);

    expect(res.body.transitions).toHaveLength(4);
    expect(res.body.transitions.map((transition: any) => transition.to)).toEqual([
      "announced",
      "src_locked",
      "dst_locked",
      "secret_revealed"
    ]);
    expect(JSON.stringify(res.body)).not.toContain("preimage");
    expect(JSON.stringify(res.body)).not.toContain(PREIMAGE);
  });

  it("returns refund transitions for a refunded order", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const app = buildApp(orders);

    const order = await orders.announce({
      direction: "eth_to_xlm",
      hashlock: "0x" + "c".repeat(64),
      srcChain: "ethereum",
      srcAddress: VALID_ETH_ADDR,
      srcAsset: "native",
      srcAmount: "1",
      srcSafetyDeposit: "1",
      dstChain: "stellar",
      dstAddress: VALID_STELLAR_ADDR,
      dstAsset: "native",
      dstAmount: "1"
    });

    await orders.recordSrcLock({
      publicId: order.publicId,
      orderId: "src-4",
      txHash: "0xsrc4",
      blockNumber: 6,
      timelock: 6000
    });
    await orders.markStatus(order.publicId, "refunded");

    const res = await request(app).get(`/api/orders/${order.publicId}/transitions`).expect(200);

    expect(res.body.transitions.map((transition: any) => transition.to)).toEqual([
      "announced",
      "src_locked",
      "refunded"
    ]);
    expect(res.body.transitions[2]).toMatchObject({ from: "src_locked", to: "refunded", category: "refunded" });
  });
});

// ─── Refused transitions (issue #252) ─────────────────────────────────────
//
// Every illegal edge must leave the stored status alone, persist the attempt
// with a stable code, and stay queryable. No chain access is involved.

async function announced(orders: OrderService, hashlockSeed = "a") {
  return orders.announce({
    direction: "eth_to_xlm",
    hashlock: "0x" + hashlockSeed.repeat(64),
    srcChain: "ethereum",
    srcAddress: VALID_ETH_ADDR,
    srcAsset: "native",
    srcAmount: "100",
    srcSafetyDeposit: "10",
    dstChain: "stellar",
    dstAddress: VALID_STELLAR_ADDR,
    dstAsset: "native",
    dstAmount: "100"
  });
}

async function srcLocked(orders: OrderService, hashlockSeed = "b") {
  const order = await announced(orders, hashlockSeed);
  await orders.recordSrcLock({
    publicId: order.publicId,
    orderId: "src-1",
    txHash: "0xsrc",
    blockNumber: 7,
    timelock: 10_000
  });
  return order;
}

async function completed(orders: OrderService, hashlockSeed = "c") {
  const order = await srcLocked(orders, hashlockSeed);
  await orders.recordDstLock({
    publicId: order.publicId,
    orderId: "dst-1",
    txHash: "0xdst",
    blockNumber: 8,
    timelock: 9_000,
    resolver: null
  });
  await orders.recordSecret(order.publicId, PREIMAGE, "0xsecret");
  await orders.recordClaim({ publicId: order.publicId, txHash: "0xclaim" });
  return order;
}

describe("OrderService — refused transitions (#252)", () => {
  it("refuses a secret before escrow, leaves the status and the history alone", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await announced(orders);

    await expect(
      orders.recordSecret(order.publicId, PREIMAGE, "0xsecret")
    ).rejects.toBeInstanceOf(OrderTransitionRejectedError);

    expect((await orders.get(order.publicId))!.status).toBe("announced");
    expect((await orders.getTransitions(order.publicId)).map((t) => t.to)).toEqual([
      "announced"
    ]);

    const rejected = await orders.getRejectedTransitions(order.publicId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      from: "announced",
      to: "secret_revealed",
      action: "secret",
      code: ORDER_FAILURE_CODES.SECRET_BEFORE_ESCROW,
      writer: "order-service",
      txHash: "0xsecret"
    });
    expect(rejected[0]!.reason).toMatch(/not escrowed/);
  });

  it("refuses a claim before the secret", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await srcLocked(orders);

    await expect(
      orders.recordClaim({ publicId: order.publicId, txHash: "0xclaim" })
    ).rejects.toBeInstanceOf(OrderTransitionRejectedError);

    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
    const rejected = await orders.getRejectedTransitions(order.publicId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      from: "src_locked",
      to: "completed",
      action: "claim",
      code: ORDER_FAILURE_CODES.CLAIM_BEFORE_SECRET
    });
  });

  it("refuses a refund after a claim and keeps the order completed", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await completed(orders);

    await expect(
      orders.recordRefund({ publicId: order.publicId, txHash: "0xrefund" })
    ).rejects.toBeInstanceOf(OrderTransitionRejectedError);

    expect((await orders.get(order.publicId))!.status).toBe("completed");
    const rejected = await orders.getRejectedTransitions(order.publicId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      from: "completed",
      to: "refunded",
      action: "refund",
      code: ORDER_FAILURE_CODES.REFUND_AFTER_CLAIM
    });
  });

  it("refuses a destination lock before escrow", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await announced(orders, "d");

    await expect(
      orders.recordDstLock({
        publicId: order.publicId,
        orderId: "dst-1",
        txHash: "0xdst",
        blockNumber: 3,
        timelock: 9_000,
        resolver: null
      })
    ).rejects.toBeInstanceOf(OrderTransitionRejectedError);

    expect((await orders.get(order.publicId))!.status).toBe("announced");
    expect((await orders.getRejectedTransitions(order.publicId))[0]).toMatchObject({
      code: ORDER_FAILURE_CODES.SECRET_RELAY_BEFORE_ESCROW,
      action: "secret_relay"
    });
  });

  it("refuses a late source event after the destination advanced", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await srcLocked(orders, "e");
    await orders.recordDstLock({
      publicId: order.publicId,
      orderId: "dst-1",
      txHash: "0xdst",
      blockNumber: 8,
      timelock: 9_000,
      resolver: null
    });

    await expect(
      orders.recordSrcLock({
        publicId: order.publicId,
        orderId: "src-old",
        txHash: "0xold",
        blockNumber: 6,
        timelock: 8_000
      })
    ).rejects.toBeInstanceOf(StaleOrderEventError);

    expect((await orders.get(order.publicId))!.status).toBe("dst_locked");
    expect((await orders.getRejectedTransitions(order.publicId))[0]).toMatchObject({
      code: ORDER_FAILURE_CODES.LATE_STEP
    });
  });

  it("treats a repeated step with an identical payload as an idempotent redelivery", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await srcLocked(orders, "f");
    const event = {
      publicId: order.publicId,
      orderId: "src-1",
      txHash: "0xsrc",
      blockNumber: 7,
      timelock: 10_000
    };

    await expect(orders.recordSrcLock(event)).resolves.toBeUndefined();
    await expect(orders.recordSrcLock(event)).resolves.toBeUndefined();

    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
    // The step advanced the order exactly once ...
    expect((await orders.getTransitions(order.publicId)).map((t) => t.to)).toEqual([
      "announced",
      "src_locked"
    ]);
    // ... and the redelivery is still on record.
    expect((await orders.getRejectedTransitions(order.publicId))[0]).toMatchObject({
      code: ORDER_FAILURE_CODES.REPEATED_STEP,
      to: "src_locked"
    });
  });

  it("refuses a repeated step with a conflicting payload", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await srcLocked(orders, "1");

    await expect(
      orders.recordSrcLock({
        publicId: order.publicId,
        orderId: "src-1",
        txHash: "0xother",
        blockNumber: 7,
        timelock: 10_000
      })
    ).rejects.toBeInstanceOf(OrderTransitionRejectedError);

    expect((await orders.get(order.publicId))!.status).toBe("src_locked");
    const rejected = await orders.getRejectedTransitions(order.publicId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: ORDER_FAILURE_CODES.CONFLICTING_STEP,
      txHash: "0xother"
    });
  });

  it("still advances the happy path exactly once", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await completed(orders, "2");

    expect((await orders.get(order.publicId))!.status).toBe("completed");
    expect((await orders.getTransitions(order.publicId)).map((t) => t.to)).toEqual([
      "announced",
      "src_locked",
      "dst_locked",
      "secret_revealed",
      "completed"
    ]);
    expect(await orders.getRejectedTransitions(order.publicId)).toEqual([]);
  });

  it("re-records a repeated secret relay from a different transaction", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const order = await srcLocked(orders, "3");

    await orders.recordSecret(order.publicId, PREIMAGE, "0xtx-1");
    await expect(
      orders.recordSecret(order.publicId, PREIMAGE, "0xtx-2")
    ).resolves.toBeUndefined();

    expect((await orders.get(order.publicId))!.status).toBe("secret_revealed");
    expect((await orders.get(order.publicId))!.preimage).toBe(PREIMAGE);
    expect((await orders.getTransitions(order.publicId)).map((t) => t.to)).toEqual([
      "announced",
      "src_locked",
      "secret_revealed"
    ]);
    const rejected = await orders.getRejectedTransitions(order.publicId);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      code: ORDER_FAILURE_CODES.REPEATED_STEP,
      txHash: "0xtx-2"
    });
  });
});

describe("HTTP refusals (#252)", () => {
  it("answers 409 with the stable code for an illegal edge", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const app = buildApp(orders);
    const order = await announced(orders, "4");

    const res = await request(app)
      .post(`/api/orders/${order.publicId}/dst-locked`)
      .send({ orderId: "dst-1", txHash: "0xdst", blockNumber: 3, timelock: 9000 })
      .expect(409);

    expect(res.body).toMatchObject({
      error: "illegal_transition",
      code: ORDER_FAILURE_CODES.SECRET_RELAY_BEFORE_ESCROW,
      from: "announced",
      to: "dst_locked",
      action: "secret_relay"
    });

    const rejected = await request(app)
      .get(`/api/orders/${order.publicId}/rejected-transitions`)
      .expect(200);
    expect(rejected.body.status).toBe("announced");
    expect(rejected.body.rejectedTransitions).toHaveLength(1);
    expect(rejected.body.rejectedTransitions[0]).toMatchObject({
      code: ORDER_FAILURE_CODES.SECRET_RELAY_BEFORE_ESCROW
    });

    const transitions = await request(app)
      .get(`/api/orders/${order.publicId}/transitions`)
      .expect(200);
    expect(transitions.body.transitions.map((t: { to: string }) => t.to)).toEqual([
      "announced"
    ]);
    expect(transitions.body.rejectedTransitions).toHaveLength(1);
  });

  it("answers 404 for refused transitions of an unknown order", async () => {
    const db = await freshDb();
    const orders = buildOrderService(db);
    const app = buildApp(orders);

    await request(app).get("/api/orders/nope/rejected-transitions").expect(404);
  });
});
