import { describe, expect, it, vi } from "vitest";
import {
  buildOrderPlan,
  PlanErrorCode,
  PlanValidationError,
  submitValidatedPlan,
  validatePlan,
  validatePlanForSubmit
} from "../src/planner/index.js";
import {
  makeOrder,
  makePlan,
  NOW,
  withLeg
} from "./fixtures/planner.js";

describe("planner.validatePlan", () => {
  it("accepts a matching plan (eligible for submit)", () => {
    const order = makeOrder();
    const plan = makePlan(order);

    const result = validatePlan(plan, order, NOW);

    expect(result.ok).toBe(true);
    expect(result.code).toBe(PlanErrorCode.Ok);
    expect(result.issues).toEqual([]);
  });

  it("rejects a hashlock mismatch with a stable code", () => {
    const order = makeOrder();
    const plan = makePlan(order, { hashlock: `0x${"cd".repeat(32)}` });

    const result = validatePlan(plan, order, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe(PlanErrorCode.HashlockMismatch);
    expect(result.issues.map((i) => i.field)).toContain("hashlock");
  });

  it("rejects a source timelock mismatch", () => {
    const order = makeOrder();
    const plan = withLeg(makePlan(order), "src", { timelock: order.src.timelock + 1 });

    const result = validatePlan(plan, order, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe(PlanErrorCode.TimelockMismatch);
    expect(result.issues.map((i) => i.field)).toContain("src.timelock");
  });

  it("rejects a destination timelock mismatch", () => {
    const order = makeOrder();
    const plan = withLeg(makePlan(order), "dst", { timelock: order.dst.timelock + 1 });

    const result = validatePlan(plan, order, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe(PlanErrorCode.TimelockMismatch);
    expect(result.issues.map((i) => i.field)).toContain("dst.timelock");
  });

  it("rejects an amount mismatch", () => {
    const order = makeOrder();
    const plan = withLeg(makePlan(order), "dst", { amount: "1" });

    const result = validatePlan(plan, order, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe(PlanErrorCode.AmountMismatch);
    expect(result.issues.map((i) => i.field)).toContain("dst.amount");
  });

  it("rejects an asset mismatch", () => {
    const order = makeOrder();
    const plan = withLeg(makePlan(order), "src", { asset: "0xdeadbeef" });

    const result = validatePlan(plan, order, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe(PlanErrorCode.AssetMismatch);
    expect(result.issues.map((i) => i.field)).toContain("src.asset");
  });

  it("rejects a plan for a different order", () => {
    const order = makeOrder();
    const plan = makePlan(order, { publicId: "ord_other" });

    const result = validatePlan(plan, order, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe(PlanErrorCode.OrderMismatch);
  });

  it("reports every mismatch, not just the first", () => {
    const order = makeOrder();
    const plan = makePlan(order, {
      hashlock: `0x${"01".repeat(32)}`,
      src: { ...order.src, amount: "9" },
      dst: { ...order.dst, asset: "0xnope" }
    });

    const result = validatePlan(plan, order, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    const fields = result.issues.map((i) => i.field);
    expect(fields).toEqual(
      expect.arrayContaining(["hashlock", "src.amount", "dst.asset"])
    );
  });

  it("rejects a plan that was valid when built but has since expired", () => {
    const order = makeOrder();
    // Built while the order was still healthy...
    const plan = buildOrderPlan(order, { now: NOW });
    expect(validatePlan(plan, order, NOW).ok).toBe(true);

    // ...but the destination window has closed by submit time.
    const submitAt = plan.expiresAt + 1;
    const result = validatePlan(plan, order, submitAt);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.code).toBe(PlanErrorCode.PlanExpired);
    expect(result.issues.map((i) => i.field)).toContain("expiresAt");
  });
});

describe("planner.validatePlanForSubmit", () => {
  it("returns the plan unchanged when still eligible", () => {
    const order = makeOrder();
    const plan = makePlan(order);

    expect(validatePlanForSubmit(plan, order, NOW)).toBe(plan);
  });

  it("throws a stable-coded error for a mismatched plan", () => {
    const order = makeOrder();
    const plan = makePlan(order, { hashlock: `0x${"ef".repeat(32)}` });

    try {
      validatePlanForSubmit(plan, order, NOW);
      throw new Error("expected validatePlanForSubmit to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanValidationError);
      expect((err as PlanValidationError).code).toBe(PlanErrorCode.HashlockMismatch);
    }
  });
});

describe("planner.submitValidatedPlan", () => {
  it("submits a matching plan", async () => {
    const order = makeOrder();
    const plan = makePlan(order);
    const submit = vi.fn().mockResolvedValue("tx-hash");

    const out = await submitValidatedPlan(plan, order, submit, NOW);

    expect(out).toBe("tx-hash");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(plan);
  });

  it("does not submit a hashlock mismatch", async () => {
    const order = makeOrder();
    const plan = makePlan(order, { hashlock: `0x${"11".repeat(32)}` });
    const submit = vi.fn();

    await expect(submitValidatedPlan(plan, order, submit, NOW)).rejects.toBeInstanceOf(
      PlanValidationError
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not submit a plan that expired between build and submit", async () => {
    const order = makeOrder();
    const plan = buildOrderPlan(order, { now: NOW });
    const submit = vi.fn();

    await expect(
      submitValidatedPlan(plan, order, submit, plan.expiresAt + 1)
    ).rejects.toMatchObject({ code: PlanErrorCode.PlanExpired });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("planner.buildOrderPlan", () => {
  it("snapshots the order instead of aliasing it", () => {
    const order = makeOrder();
    const plan = buildOrderPlan(order, { now: NOW });

    expect(plan).toMatchObject({
      publicId: order.publicId,
      hashlock: order.hashlock,
      action: "fill",
      src: order.src,
      dst: order.dst
    });
    expect(plan.src).not.toBe(order.src);
    expect(plan.dst).not.toBe(order.dst);
  });

  it("defaults the deadline to the earlier leg timelock", () => {
    const order = makeOrder();
    const plan = buildOrderPlan(order, { now: NOW });
    expect(plan.expiresAt).toBe(Math.min(order.src.timelock, order.dst.timelock));
  });

  it("honours the action and deadline overrides", () => {
    const order = makeOrder();
    const plan = buildOrderPlan(order, { action: "claim", expiresAt: NOW + 5, now: NOW });
    expect(plan.action).toBe("claim");
    expect(plan.expiresAt).toBe(NOW + 5);
    expect(plan.builtAt).toBe(NOW);
  });
});
