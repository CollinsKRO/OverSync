import { describe, it, expect } from "vitest";
import {
  CURSOR_VERSION,
  decodeHistoryCursor,
  encodeHistoryCursor,
  validateHistoryCursor
} from "../src/server/routes/cursor-utils.js";

const USER = "0x1111111111111111111111111111111111111111";
const OTHER_USER = "0x2222222222222222222222222222222222222222";
const PUBLIC_ID = "a".repeat(32);
const OTHER_PUBLIC_ID = "b".repeat(32);

const keyset = {
  createdAt: 1_700_000_000,
  publicId: PUBLIC_ID,
  user: USER,
  network: "testnet" as const
};

const scope = { user: USER, network: "testnet" as const };

/** Builds a raw token with a hand-rolled payload, bypassing the encoder. */
function token(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("encodeHistoryCursor", () => {
  it("round-trips through decode without losing the keyset", () => {
    const encoded = encodeHistoryCursor(keyset);
    expect(decodeHistoryCursor(encoded)).toEqual(keyset);
  });

  it("emits a URL-safe token with no padding or reserved characters", () => {
    const encoded = encodeHistoryCursor(keyset);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(encoded)).toBe(encoded);
  });

  it("normalises the user so casing differences do not change the token", () => {
    const lower = encodeHistoryCursor(keyset);
    const mixed = encodeHistoryCursor({ ...keyset, user: "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x") });
    expect(mixed).toBe(lower);
  });

  it("distinguishes networks", () => {
    expect(encodeHistoryCursor({ ...keyset, network: "mainnet" })).not.toBe(
      encodeHistoryCursor(keyset)
    );
  });
});

describe("decodeHistoryCursor", () => {
  it("rejects an empty string", () => {
    expect(decodeHistoryCursor("")).toBeNull();
  });

  it("rejects a non-string", () => {
    expect(decodeHistoryCursor(undefined)).toBeNull();
    expect(decodeHistoryCursor(null)).toBeNull();
    expect(decodeHistoryCursor(42)).toBeNull();
  });

  it("rejects a token that is not base64url JSON", () => {
    expect(decodeHistoryCursor("not-a-cursor")).toBeNull();
  });

  it("rejects the legacy createdAt:publicId format", () => {
    // The old shape was a `::`/`:`-joined string, never a versioned object.
    const legacy = Buffer.from(`${keyset.createdAt}::${PUBLIC_ID}`, "utf8").toString("base64");
    expect(decodeHistoryCursor(legacy)).toBeNull();
  });

  it("rejects an unsupported version", () => {
    const encoded = token({ v: CURSOR_VERSION + 1, c: 1, p: PUBLIC_ID, u: USER, n: "testnet" });
    expect(decodeHistoryCursor(encoded)).toBeNull();
  });

  it("rejects a public id that is not 32 lowercase hex chars", () => {
    for (const bad of ["", "abc", PUBLIC_ID.toUpperCase(), "0x" + PUBLIC_ID, "g".repeat(32)]) {
      expect(decodeHistoryCursor(token({ v: CURSOR_VERSION, c: 1, p: bad, u: USER, n: "testnet" }))).toBeNull();
    }
  });

  it("rejects a non-integer or negative timestamp", () => {
    for (const bad of [1.5, -1, "1700000000", null, Number.NaN]) {
      expect(decodeHistoryCursor(token({ v: CURSOR_VERSION, c: bad, p: PUBLIC_ID, u: USER, n: "testnet" }))).toBeNull();
    }
  });

  it("rejects an unknown network", () => {
    expect(decodeHistoryCursor(token({ v: CURSOR_VERSION, c: 1, p: PUBLIC_ID, u: USER, n: "devnet" }))).toBeNull();
  });

  it("rejects a payload with a missing user", () => {
    expect(decodeHistoryCursor(token({ v: CURSOR_VERSION, c: 1, p: PUBLIC_ID, n: "testnet" }))).toBeNull();
  });

  it("rejects a JSON scalar", () => {
    expect(decodeHistoryCursor(token(7))).toBeNull();
    expect(decodeHistoryCursor(token(null))).toBeNull();
  });
});

describe("validateHistoryCursor", () => {
  it("accepts a cursor issued for the same user and network", () => {
    const result = validateHistoryCursor(encodeHistoryCursor(keyset), scope);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cursor).toEqual(keyset);
    }
  });

  it("rejects a cursor minted for another user", () => {
    const foreign = encodeHistoryCursor({ ...keyset, user: OTHER_USER });
    const result = validateHistoryCursor(foreign, scope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("user_mismatch");
  });

  it("rejects a cursor minted on another network", () => {
    const mainnet = encodeHistoryCursor({ ...keyset, network: "mainnet" });
    const result = validateHistoryCursor(mainnet, scope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("network_mismatch");
  });

  it("compares the user case-insensitively", () => {
    const upper = encodeHistoryCursor({ ...keyset, user: `0x${PUBLIC_ID.slice(0, 40).toUpperCase()}` });
    // Different user entirely, just written in uppercase.
    const result = validateHistoryCursor(upper, { user: `0x${PUBLIC_ID.slice(0, 40).toUpperCase()}`, network: "testnet" });
    expect(result.ok).toBe(true);
  });

  it("rejects garbage as malformed rather than as a user mismatch", () => {
    const result = validateHistoryCursor("nonsense", scope);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("carries a message suitable for surfacing to the user", () => {
    const result = validateHistoryCursor("nonsense", scope);
    if (!result.ok) expect(result.message).toMatch(/cursor/i);
  });
});
