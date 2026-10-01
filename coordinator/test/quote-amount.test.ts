/**
 * Amount parsing parity between the bridge form and the coordinator quote.
 *
 * The vectors mirror frontend/src/lib/sanitizeAmountInput.test.ts: the
 * form and the coordinator must parse the same text to the same base-unit
 * integer, and an order whose srcAmount differs from the quoted amount
 * must not be created. CoinGecko is stubbed — no live quoter is called.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/persistence/db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { OrderService, OrderValidationError } from "../src/services/order-service.js";
import {
  AmountParseError,
  QuoteAmountMismatchError,
  QuoteService,
  parseAmountToBaseUnits
} from "../src/services/quote-service.js";

const log = pino({ level: "silent" });

const BASE_ANNOUNCE = {
  direction: "eth_to_xlm" as const,
  hashlock: "0x" + "c".repeat(64),
  srcChain: "ethereum" as const,
  srcAddress: "0x2222222222222222222222222222222222222222",
  srcAsset: "native",
  srcAmount: "1500000000000000000",
  srcSafetyDeposit: "1000000000000000",
  dstChain: "stellar" as const,
  dstAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  dstAsset: "native",
  dstAmount: "100000000"
};

function stubQuoter() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ethereum: { usd: 2000 }, stellar: { usd: 0.1 } })
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function freshDb() {
  const dir = mkdtempSync(resolve(tmpdir(), "oversync-quote-amount-"));
  return openDatabase(`file:${dir}/test.db`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseAmountToBaseUnits (coordinator)", () => {
  it("parses a valid decimal to the same integer as the form", () => {
    expect(parseAmountToBaseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
    expect(parseAmountToBaseUnits("0.1", 18)).toBe(100_000_000_000_000_000n);
    expect(parseAmountToBaseUnits("12.", 7)).toBe(120_000_000n);
    expect(parseAmountToBaseUnits(".5", 7)).toBe(5_000_000n);
    expect(parseAmountToBaseUnits("0.0000001", 7)).toBe(1n);
  });

  it("rejects an extra fractional digit", () => {
    expect(() => parseAmountToBaseUnits("0.00000001", 7)).toThrow(AmountParseError);
    expect(() => parseAmountToBaseUnits("1.1234567890123456789", 18)).toThrow(AmountParseError);
  });

  it("rejects empty, negative, and non-decimal input", () => {
    for (const bad of ["", ".", "-1", "1e3", "1,5"]) {
      expect(() => parseAmountToBaseUnits(bad, 18)).toThrow(AmountParseError);
    }
  });

  it("keeps full precision above Number.MAX_SAFE_INTEGER", () => {
    expect(parseAmountToBaseUnits("9007199254740993.000000000000000001", 18)).toBe(
      9_007_199_254_740_993_000_000_000_000_000_001n
    );
  });
});

describe("QuoteService amount binding", () => {
  it("binds the quote to the base-unit integer, not raw decimal text", async () => {
    stubQuoter();
    const svc = new QuoteService(log);
    const q = await svc.quoteEthXlm({ amountBaseUnits: "1500000000000000000" });
    expect(q.amountBaseUnits).toBe("1500000000000000000");
    await expect(svc.quoteEthXlm({ amountBaseUnits: "1.5" })).rejects.toThrow(AmountParseError);
    await expect(svc.quoteEthXlm({ amountBaseUnits: "-1" })).rejects.toThrow(AmountParseError);
  });

  it("stores a value above the safe integer range without precision loss", async () => {
    stubQuoter();
    const svc = new QuoteService(log);
    const big = "9007199254740993000000000000000001";
    const q = await svc.quoteEthXlm({ amountBaseUnits: big });
    expect(svc.assertFresh(q.quoteId, big).amountBaseUnits).toBe(big);
    expect(() => svc.assertFresh(q.quoteId, "9007199254740993000000000000000000")).toThrow(
      QuoteAmountMismatchError
    );
  });

  it("does not leak one caller's amount into a cache-reissued quote", async () => {
    const fetchMock = stubQuoter();
    const svc = new QuoteService(log);
    await svc.quoteEthXlm({ amountBaseUnits: "1" });
    const second = await svc.quoteEthXlm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.amountBaseUnits).toBeUndefined();
  });
});

describe("OrderService.announce — quote amount gate", () => {
  it("creates the order when srcAmount equals the quoted amount", async () => {
    stubQuoter();
    const quotes = new QuoteService(log);
    const orders = new OrderService(new OrdersRepository(await freshDb()), log, quotes);
    const formAmount = parseAmountToBaseUnits("1.5", 18).toString();
    const q = await quotes.quoteEthXlm({ amountBaseUnits: formAmount });

    const order = await orders.announce({ ...BASE_ANNOUNCE, srcAmount: formAmount, quoteId: q.quoteId });
    expect(order.status).toBe("announced");
  });

  it("does not create an order when srcAmount differs from the quoted amount", async () => {
    stubQuoter();
    const db = await freshDb();
    const repo = new OrdersRepository(db);
    const quotes = new QuoteService(log);
    const orders = new OrderService(repo, log, quotes);
    const q = await quotes.quoteEthXlm({ amountBaseUnits: "1500000000000000000" });

    await expect(
      orders.announce({ ...BASE_ANNOUNCE, srcAmount: "1499999999999999999", quoteId: q.quoteId })
    ).rejects.toThrow(OrderValidationError);
    expect(await repo.findByHashlock(BASE_ANNOUNCE.hashlock as `0x${string}`)).toBeFalsy();
  });
});
