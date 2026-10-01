import { describe, expect, it } from "vitest";
import { LegacyLockError, resolveLockTarget } from "../src/services/order-service.js";

const LEGACY = "0x1111111111111111111111111111111111111111";
const V2 = "0x2222222222222222222222222222222222222222";

describe("legacy lock target", () => {
  it("keeps the legacy target when no v2 escrow is configured", () => {
    expect(resolveLockTarget({ requestedTarget: LEGACY, legacyBridge: LEGACY, v2Escrow: "" }).target).toBe(LEGACY);
  });

  it("does not build a lock aimed at the legacy bridge when v2 is set", () => {
    expect(() => resolveLockTarget({ requestedTarget: LEGACY, legacyBridge: LEGACY, v2Escrow: V2 })).toThrow(LegacyLockError);
  });

  it("uses the v2 escrow for a non-legacy request", () => {
    expect(resolveLockTarget({ requestedTarget: V2, legacyBridge: LEGACY, v2Escrow: V2 }).target).toBe(V2);
  });
});
