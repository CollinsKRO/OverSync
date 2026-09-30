/**
 * Coordinator unit tests for OrderService.buildClaim — issue #257.
 *
 * Verifies that the coordinator refuses to build a claim payload when:
 *   - the resolver address was never registered in the registry, or
 *   - the resolver was registered at the time the order opened but has
 *     since been removed.
 *
 * Also verifies the happy path: a currently-registered resolver can
 * successfully retrieve the order for claiming.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import {
  OrderService,
  OrderValidationError,
  type ResolverRegistryPort
} from "../src/services/order-service.js";

const log = pino({ level: "silent" });

const VALID_HASHLOCK = "0x" + "b".repeat(64);
const VALID_ETH_ADDR = "0x2222222222222222222222222222222222222222";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";
const RESOLVER_ADDR = "0x3333333333333333333333333333333333333333";
const NON_RESOLVER_ADDR = "0x4444444444444444444444444444444444444444";

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "oversync-buildclaim-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

/** Advance an order to dst_locked status so buildClaim can operate on it. */
async function announceAndLock(svc: OrderService, hashlock = VALID_HASHLOCK) {
  const order = await svc.announce({
    direction: "eth_to_xlm",
    hashlock,
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

  await svc.recordSrcLock({
    publicId: order.publicId,
    orderId: "src-1",
    txHash: "0xsrc",
    blockNumber: 1,
    timelock: 10_000
  });

  await svc.recordDstLock({
    publicId: order.publicId,
    orderId: "dst-1",
    txHash: "0xdst",
    blockNumber: 2,
    timelock: 9_000,
    resolver: RESOLVER_ADDR
  });

  return order;
}

describe("OrderService.buildClaim — resolver registry gate (issue #257)", () => {
  it("succeeds when no registry is wired (open mode)", async () => {
    const db = await freshDb();
    // No registry passed → buildClaim skips the check entirely.
    const svc = new OrderService(new OrdersRepository(db), log);
    const order = await announceAndLock(svc);

    // Any address can build a claim in open mode.
    const result = await svc.buildClaim(order.publicId, NON_RESOLVER_ADDR);
    expect(result.publicId).toBe(order.publicId);
    expect(result.status).toBe("dst_locked");
  });

  it("succeeds for a currently-registered resolver", async () => {
    const db = await freshDb();

    // Registry stub: RESOLVER_ADDR is active.
    const registry: ResolverRegistryPort = {
      isActive: vi.fn(async (addr) => addr === RESOLVER_ADDR)
    };

    const svc = new OrderService(new OrdersRepository(db), log, undefined, undefined, registry);
    const order = await announceAndLock(svc);

    const result = await svc.buildClaim(order.publicId, RESOLVER_ADDR);
    expect(result.publicId).toBe(order.publicId);
    expect(registry.isActive).toHaveBeenCalledWith(RESOLVER_ADDR);
  });

  it("rejects a claim for an address that was never registered", async () => {
    const db = await freshDb();

    // Registry stub: no address is active.
    const registry: ResolverRegistryPort = {
      isActive: vi.fn(async () => false)
    };

    const svc = new OrderService(new OrdersRepository(db), log, undefined, undefined, registry);
    const order = await announceAndLock(svc);

    await expect(
      svc.buildClaim(order.publicId, NON_RESOLVER_ADDR)
    ).rejects.toThrow(OrderValidationError);

    await expect(
      svc.buildClaim(order.publicId, NON_RESOLVER_ADDR)
    ).rejects.toThrow(/not registered or has been removed/);
  });

  it("rejects a claim for a resolver removed after the order was opened", async () => {
    const db = await freshDb();

    // Simulate: resolver was active when the order was created, but has
    // since been removed.  The registry stub always returns false now.
    let resolverRemoved = false;
    const registry: ResolverRegistryPort = {
      isActive: vi.fn(async () => !resolverRemoved)
    };

    const svc = new OrderService(new OrdersRepository(db), log, undefined, undefined, registry);
    const order = await announceAndLock(svc);

    // Verify that before removal the resolver could build a claim.
    await expect(svc.buildClaim(order.publicId, RESOLVER_ADDR)).resolves.toBeDefined();

    // Resolver is now removed from the registry.
    resolverRemoved = true;

    // After removal, buildClaim must refuse.
    await expect(
      svc.buildClaim(order.publicId, RESOLVER_ADDR)
    ).rejects.toThrow(OrderValidationError);
  });

  it("rejects when the order is not in dst_locked state", async () => {
    const db = await freshDb();

    const registry: ResolverRegistryPort = {
      isActive: vi.fn(async () => true)
    };

    const svc = new OrderService(new OrdersRepository(db), log, undefined, undefined, registry);

    // Order is only announced — not yet dst_locked.
    const order = await svc.announce({
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

    await expect(
      svc.buildClaim(order.publicId, RESOLVER_ADDR)
    ).rejects.toThrow(OrderValidationError);

    // Registry should not even be consulted for state-machine rejections.
    expect(registry.isActive).not.toHaveBeenCalled();
  });

  it("rejects when the order does not exist", async () => {
    const db = await freshDb();

    const registry: ResolverRegistryPort = {
      isActive: vi.fn(async () => true)
    };

    const svc = new OrderService(new OrdersRepository(db), log, undefined, undefined, registry);

    await expect(
      svc.buildClaim("nonexistent-order-id", RESOLVER_ADDR)
    ).rejects.toThrow(OrderValidationError);
  });
});
