/**
 * Shared planner fixtures.
 *
 * Kept in one place so the planner tests exercise the same canonical
 * order/plan pair and only vary the field under test.
 */

import type { PlanLeg, ResolverOrder, ResolverPlan } from "../../src/planner/index.js";

/** Deterministic "now" so expiry tests never depend on the wall clock. */
export const NOW = 1_800_000_000;

const XLM_ASSET = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const WETH = "0x4200000000000000000000000000000000000006";

/** Canonical order used across the suite: ETH -> XLM. */
export function makeOrder(overrides: Partial<ResolverOrder> = {}): ResolverOrder {
  const src: PlanLeg = {
    chain: "ethereum",
    asset: WETH,
    amount: "500000000000000000",
    timelock: NOW + 24 * 60 * 60
  };
  const dst: PlanLeg = {
    chain: "stellar",
    asset: XLM_ASSET,
    amount: "5000000000",
    timelock: NOW + 12 * 60 * 60
  };
  return {
    publicId: "ord_planner_1",
    direction: "eth_to_xlm",
    hashlock: `0x${"ab".repeat(32)}`,
    src: overrides.src ?? src,
    dst: overrides.dst ?? dst,
    ...overrides
  };
}

/** A plan that matches {@link makeOrder} exactly. */
export function makePlan(
  order: ResolverOrder = makeOrder(),
  overrides: Partial<ResolverPlan> = {}
): ResolverPlan {
  return {
    publicId: order.publicId,
    action: "fill",
    hashlock: order.hashlock,
    src: { ...order.src },
    dst: { ...order.dst },
    expiresAt: Math.min(order.src.timelock, order.dst.timelock),
    builtAt: NOW,
    ...overrides
  };
}

/** Convenience: clone `plan` with a patched leg. */
export function withLeg(
  plan: ResolverPlan,
  which: "src" | "dst",
  patch: Partial<PlanLeg>
): ResolverPlan {
  return { ...plan, [which]: { ...plan[which], ...patch } };
}
