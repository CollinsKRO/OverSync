export interface BridgeSdkContext {
  network: string;
  escrow: string;
  registry: string;
}

export interface BridgeOrderContext {
  id: string;
  network: string;
  escrow: string;
  registry: string;
}

export function buildBridgeCall(
  context: BridgeSdkContext,
  order: BridgeOrderContext,
  action: "claim" | "refund" | "lock",
): { ok: true; call: { action: string; orderId: string; escrow: string; network: string; registry: string } } | { ok: false; error: "context_mismatch"; call: null } {
  if (
    context.network !== order.network ||
    context.escrow.toLowerCase() !== order.escrow.toLowerCase() ||
    context.registry.toLowerCase() !== order.registry.toLowerCase()
  ) {
    return { ok: false, error: "context_mismatch", call: null };
  }
  return {
    ok: true,
    call: { action, orderId: order.id, escrow: order.escrow, network: order.network, registry: order.registry },
  };
}
