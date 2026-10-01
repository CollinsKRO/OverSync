/**
 * Quote freshness and expiry enforcement tests.
 *
 * Covers:
 *  - Fresh quote is accepted by QuoteService.assertFresh
 *  - Expired quote is rejected by QuoteService.assertFresh
 *  - Boundary: quote at exactly expiresAt is NOT expired (strict >);
 *    one ms later IS expired
 *  - Missing / unknown quoteId throws QuoteNotFoundError
 *  - OrderService.announce rejects an expired quoteId before persisting
 *  - OrderService.announce accepts a fresh quoteId
 *  - OrderService.announce proceeds normally when no quoteId is provided
 *  - QuoteService.evictExpired removes stale entries and leaves fresh ones
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import pino from "pino";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService, OrderValidationError } from "../src/services/order-service.js";
import { createApp } from "../src/server/app.js";
import type { SecretService } from "../src/services/secret-service.js";
import {
  QuoteService,
  QuoteExpiredError,
  QuoteNotFoundError
} from "../src/services/quote-service.js";

// ── Shared fixtures ──────────────────────────────────────────────────────────

const log = pino({ level: "silent" });

const VALID_HASHLOCK   = "0x" + "b".repeat(64);
const VALID_ETH_ADDR   = "0x2222222222222222222222222222222222222222";
const VALID_STELLAR    = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

const BASE_ANNOUNCE = {
  direction:        "eth_to_xlm" as const,
  hashlock:         VALID_HASHLOCK,
  srcChain:         "ethereum"   as const,
  srcAddress:       VALID_ETH_ADDR,
  srcAsset:         "native",
  srcAmount:        "1000000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain:         "stellar"    as const,
  dstAddress:       VALID_STELLAR,
  dstAsset:         "native",
  dstAmount:        "100000000",
};

const BASE_TERMS = {
  srcChain: "ethereum" as const,
  srcAsset: "native",
  srcAmount: "1000000000000000000",
  dstChain: "stellar" as const,
  dstAsset: "native",
  dstAmount: "100000000"
};

/** Returns a silent pino mock of CoinGecko that succeeds. */
function mockCoingecko() {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    json: async () => ({ ethereum: { usd: 2000 }, stellar: { usd: 0.1 } }),
  }));
}

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "oversync-quote-test-"));
  return openDatabase(`file:${dir}/test.db`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── QuoteService unit tests ──────────────────────────────────────────────────

describe("QuoteService — quote lifecycle", () => {
  it("returns a PriceQuote with quoteId, issuedAt, and expiresAt = issuedAt + 30 s", async () => {
    const now = vi.fn(() => 1_000_000);
    const svc = new QuoteService(log, now);
    mockCoingecko();

    const q = await svc.quoteEthXlm(BASE_TERMS);

    expect(q.quoteId).toMatch(/^[a-f0-9]{32}$/);
    expect(q.issuedAt).toBe(1_000_000);
    expect(q.expiresAt).toBe(1_030_000);
    expect(q.srcUsd).toBe("2000");
    expect(q.dstUsd).toBe("0.1");
    expect(q.source).toBe("coingecko");
  });

  it("getById returns the quote by its id", async () => {
    const svc = new QuoteService(log);
    mockCoingecko();

    const q = await svc.quoteEthXlm(BASE_TERMS);
    expect(svc.getById(q.quoteId)).toMatchObject({ quoteId: q.quoteId });
  });

  it("getById returns null for an unknown id", () => {
    const svc = new QuoteService(log);
    expect(svc.getById("unknown")).toBeNull();
  });
});

// ── assertFresh — fresh quote ────────────────────────────────────────────────

describe("QuoteService.assertFresh — fresh quote", () => {
  it("does not throw when now < expiresAt", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    const svc = new QuoteService(log, now);
    mockCoingecko();

    const q = await svc.quoteEthXlm(BASE_TERMS);

    nowMs = 1_010_000; // +10 s, well within 30 s TTL
    const result = svc.assertFresh(q.quoteId);
    expect(result.quoteId).toBe(q.quoteId);
  });
});

// ── assertFresh — expired quote ──────────────────────────────────────────────

describe("QuoteService.assertFresh — expired quote", () => {
  it("throws QuoteExpiredError when now > expiresAt", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    const svc = new QuoteService(log, now);
    mockCoingecko();

    const q = await svc.quoteEthXlm(BASE_TERMS);

    nowMs = q.expiresAt + 1; // one ms past the deadline
    expect(() => svc.assertFresh(q.quoteId)).toThrowError(QuoteExpiredError);
  });

  it("QuoteExpiredError carries the original expiry timestamp", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    const svc = new QuoteService(log, now);
    mockCoingecko();

    const q = await svc.quoteEthXlm(BASE_TERMS);
    nowMs = q.expiresAt + 5_000;

    let caught: QuoteExpiredError | undefined;
    try {
      svc.assertFresh(q.quoteId);
    } catch (e) {
      caught = e as QuoteExpiredError;
    }
    expect(caught).toBeInstanceOf(QuoteExpiredError);
    expect(caught!.expiredMs).toBe(q.expiresAt);
    expect(caught!.quoteId).toBe(q.quoteId);
  });
});

// ── assertFresh — boundary timestamp ────────────────────────────────────────

describe("QuoteService.assertFresh — boundary timestamp", () => {
  it("is still fresh when now === expiresAt (condition is strictly >)", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    const svc = new QuoteService(log, now);
    mockCoingecko();

    const q = await svc.quoteEthXlm(BASE_TERMS);

    // Exact boundary — NOT expired
    nowMs = q.expiresAt;
    expect(() => svc.assertFresh(q.quoteId)).not.toThrow();

    // One ms past — expired
    nowMs = q.expiresAt + 1;
    expect(() => svc.assertFresh(q.quoteId)).toThrowError(QuoteExpiredError);
  });
});

// ── assertFresh — missing quoteId ────────────────────────────────────────────

describe("QuoteService.assertFresh — missing quoteId", () => {
  it("throws QuoteNotFoundError for an id that was never issued", () => {
    const svc = new QuoteService(log);
    expect(() => svc.assertFresh("never-issued")).toThrowError(QuoteNotFoundError);
  });

  it("throws QuoteNotFoundError for an empty string", () => {
    const svc = new QuoteService(log);
    expect(() => svc.assertFresh("")).toThrowError(QuoteNotFoundError);
  });
});

// ── evictExpired ─────────────────────────────────────────────────────────────

describe("QuoteService.evictExpired", () => {
  it("removes expired quotes and returns the count", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    const svc = new QuoteService(log, now);
    mockCoingecko();

    const q1 = await svc.quoteEthXlm(BASE_TERMS);

    // Advance past the price-cache TTL so quoteEthXlm fetches again
    nowMs = q1.expiresAt + 1;
    const q2 = await svc.quoteEthXlm(BASE_TERMS);

    // Advance past q2's expiry too
    nowMs = q2.expiresAt + 1;

    const evicted = svc.evictExpired();
    expect(evicted).toBeGreaterThanOrEqual(2);
    expect(svc.getById(q1.quoteId)).toBeNull();
    expect(svc.getById(q2.quoteId)).toBeNull();
  });

  it("leaves unexpired quotes intact", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    const svc = new QuoteService(log, now);
    mockCoingecko();

    const q = await svc.quoteEthXlm(BASE_TERMS);

    nowMs = 1_005_000; // +5 s, inside 30 s TTL
    svc.evictExpired();

    expect(svc.getById(q.quoteId)).not.toBeNull();
  });

  it("returns 0 when nothing is expired", () => {
    const svc = new QuoteService(log);
    expect(svc.evictExpired()).toBe(0);
  });
});

// ── OrderService integration ─────────────────────────────────────────────────

describe("OrderService.announce — quote freshness gate", () => {
  it("accepts an order when quoteId is omitted", async () => {
    const db = await freshDb();
    const orders = new OrderService(new OrdersRepository(db), log);

    const order = await orders.announce(BASE_ANNOUNCE);
    expect(order.status).toBe("announced");
  });

  it("accepts an order when quoteId references a fresh quote", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    mockCoingecko();

    const db        = await freshDb();
    const quoteSvc  = new QuoteService(log, now);
    const orders    = new OrderService(new OrdersRepository(db), log, quoteSvc);

    const q = await quoteSvc.quoteEthXlm(BASE_TERMS);

    nowMs = 1_010_000; // still fresh
    const order = await orders.announce({ ...BASE_ANNOUNCE, quoteId: q.quoteId });
    expect(order.status).toBe("announced");
    expect(quoteSvc.getById(q.quoteId)?.terms).toEqual({
      fromAsset: BASE_ANNOUNCE.srcAsset,
      toAsset: BASE_ANNOUNCE.dstAsset,
      amount: BASE_ANNOUNCE.srcAmount,
      fromNetwork: BASE_ANNOUNCE.srcChain,
      toNetwork: BASE_ANNOUNCE.dstChain
    });
  });

  it("rejects an order when quoteId references an expired quote", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    mockCoingecko();

    const db       = await freshDb();
    const quoteSvc = new QuoteService(log, now);
    const orders   = new OrderService(new OrdersRepository(db), log, quoteSvc);

    const q = await quoteSvc.quoteEthXlm(BASE_TERMS);

    nowMs = q.expiresAt + 1; // past expiry
    await expect(
      orders.announce({ ...BASE_ANNOUNCE, quoteId: q.quoteId })
    ).rejects.toThrowError(OrderValidationError);
  });

  it("rejects an order when quoteId is unknown (never issued)", async () => {
    const db       = await freshDb();
    const quoteSvc = new QuoteService(log);
    const orders   = new OrderService(new OrdersRepository(db), log, quoteSvc);

    await expect(
      orders.announce({ ...BASE_ANNOUNCE, quoteId: "this-id-was-never-issued" })
    ).rejects.toThrowError(OrderValidationError);
  });

  it("does NOT persist the order row when the quote is expired", async () => {
    let nowMs = 1_000_000;
    const now = vi.fn(() => nowMs);
    mockCoingecko();

    const db       = await freshDb();
    const quoteSvc = new QuoteService(log, now);
    const repo     = new OrdersRepository(db);
    const orders   = new OrderService(repo, log, quoteSvc);

    const q = await quoteSvc.quoteEthXlm(BASE_TERMS);
    nowMs = q.expiresAt + 1;

    await expect(
      orders.announce({ ...BASE_ANNOUNCE, quoteId: q.quoteId })
    ).rejects.toThrowError(OrderValidationError);

    // The hashlock must not have been written to the DB
    const persisted = await repo.findByHashlock(VALID_HASHLOCK);
    expect(persisted).toBeNull();
  });

  it("does NOT persist the order row when the quoteId is unknown", async () => {
    const db       = await freshDb();
    const quoteSvc = new QuoteService(log);
    const repo     = new OrdersRepository(db);
    const orders   = new OrderService(repo, log, quoteSvc);

    await expect(
      orders.announce({ ...BASE_ANNOUNCE, quoteId: "ghost-id" })
    ).rejects.toThrowError(OrderValidationError);

    const persisted = await repo.findByHashlock(VALID_HASHLOCK);
    expect(persisted).toBeNull();
  });
});

describe("quote and order routes", () => {
  async function routeHarness(now: () => number) {
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const quoteSvc = new QuoteService(log, now);
    const orders = new OrderService(repo, log, quoteSvc);
    const app = createApp({
      log,
      corsOrigins: ["*"],
      maxRequestBodyBytes: 65_536,
      orders,
      secrets: {} as SecretService,
      quotes: quoteSvc
    });
    return { app, repo, quoteSvc };
  }

  async function issueRouteQuote(app: ReturnType<typeof createApp>) {
    return request(app).get("/api/quotes/eth-xlm").query(BASE_TERMS);
  }

  it("creates one order from a fresh matching route quote", async () => {
    mockCoingecko();
    const { app, repo } = await routeHarness(() => 1_000_000);
    const quoteResponse = await issueRouteQuote(app);

    expect(quoteResponse.status).toBe(200);
    expect(quoteResponse.body).toMatchObject(BASE_TERMS);

    const orderResponse = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, quoteId: quoteResponse.body.quoteId });

    expect(orderResponse.status).toBe(201);
    expect(await repo.findByHashlock(VALID_HASHLOCK)).not.toBeNull();
  });

  it("rejects an expired route quote without creating an order", async () => {
    mockCoingecko();
    let nowMs = 1_000_000;
    const { app, repo } = await routeHarness(() => nowMs);
    const quoteResponse = await issueRouteQuote(app);
    nowMs = quoteResponse.body.expiresAt + 1;

    const orderResponse = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, quoteId: quoteResponse.body.quoteId });

    expect(orderResponse.status).toBe(400);
    expect(orderResponse.body.error).toBe("quote_expired");
    expect(await repo.findByHashlock(VALID_HASHLOCK)).toBeNull();
  });

  it.each([
    ["amount", { srcAmount: "2" }],
    ["network", {
      direction: "xlm_to_eth",
      srcChain: "stellar",
      srcAddress: VALID_STELLAR,
      dstChain: "ethereum",
      dstAddress: VALID_ETH_ADDR
    }]
  ])("rejects %s drift without creating an order", async (_kind, changedTerms) => {
    mockCoingecko();
    const { app, repo } = await routeHarness(() => 1_000_000);
    const quoteResponse = await issueRouteQuote(app);

    const orderResponse = await request(app)
      .post("/api/orders/announce")
      .send({ ...BASE_ANNOUNCE, ...changedTerms, quoteId: quoteResponse.body.quoteId });

    expect(orderResponse.status).toBe(400);
    expect(orderResponse.body.error).toBe("quote_mismatch");
    expect(await repo.findByHashlock(VALID_HASHLOCK)).toBeNull();
  });
});
