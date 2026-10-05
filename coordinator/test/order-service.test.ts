import { describe, it, expect } from "vitest";
import { LegacyLockError, resolveLockTarget } from "../src/services/order-service.js";

const LEGACY = "0x1111111111111111111111111111111111111111";
const V2 = "0x2222222222222222222222222222222222222222";

describe("OrderService legacy bridge rejection", () => {
  it("should reject legacy bridge requests when v2 escrow is active", () => {
    expect(() =>
      resolveLockTarget({ requestedTarget: LEGACY, legacyBridge: LEGACY, v2Escrow: V2 })
    ).toThrow(LegacyLockError);
  });

  it("should allow v2 escrow requests", () => {
    const result = resolveLockTarget({ requestedTarget: V2, legacyBridge: LEGACY, v2Escrow: V2 });
    expect(result.target).toBe(V2);
  });

  it("keeps the legacy target when no v2 escrow is configured", () => {
    const result = resolveLockTarget({ requestedTarget: LEGACY, legacyBridge: LEGACY, v2Escrow: "" });
    expect(result.target).toBe(LEGACY);
  });
});
