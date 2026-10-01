import { describe, expect, it } from "vitest";
import { buildBridgeCall, type BridgeOrderContext, type BridgeSdkContext } from "./bridge-call";

const context: BridgeSdkContext = { network: "testnet", escrow: "0xescrow", registry: "0xregistry" };

function order(patch: Partial<BridgeOrderContext> = {}): BridgeOrderContext {
  return { id: "order_1", network: "testnet", escrow: "0xescrow", registry: "0xregistry", ...patch };
}

describe("sdk context", () => {
  it("builds one call when the order matches", () => {
    const result = buildBridgeCall(context, order(), "lock");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.call.orderId).toBe("order_1");
  });

  it("builds nothing for a different escrow", () => {
    expect(buildBridgeCall(context, order({ escrow: "0xother" }), "claim")).toEqual({
      ok: false,
      error: "context_mismatch",
      call: null,
    });
  });

  it("builds nothing for a different network and uses the latest order", () => {
    const first = buildBridgeCall(context, order({ network: "mainnet" }), "refund");
    expect(first.call).toBeNull();
    const updated = buildBridgeCall(context, order({ id: "order_2" }), "refund");
    expect(updated.ok && updated.call.orderId).toBe("order_2");
  });
});
