import type { ResolverConfig } from "../config.js";

/**
 * Planner validation for the OverSync resolver.
 *
 * A *plan* is what a resolver intends to submit on a chain (lock the
 * destination leg, or claim the source leg). The resolver builds it
 * from its own local view, which can drift from the canonical
 * coordinator order between the moment the plan is built and the
 * moment it is submitted. Submitting a drifted plan is dangerous:
 *
 * - a stale hashlock would claim/refund the **wrong escrow**;
 * - a stale timelock could let the resolver lock funds that expire
 *   before the counterparty can claim them, or claim after the
 *   counterparty has already refunded;
 * - a stale amount/asset would lock the wrong value.
 *
 * This module refuses such plans with a *stable* machine-readable code
 * so callers (and tests) never have to match on prose. Callers MUST
 * validate again immediately before submitting, not only when the plan
 * is first built — see {@link validatePlanForSubmit}.
 */

export type Chain = "ethereum" | "stellar";

/** A single side of an order or plan. Amounts are atomic units. */
export interface PlanLeg {
  chain: Chain;
  /** Asset identifier: 0x address (EVM) or contract id (Soroban). */
  asset: string;
  /** Amount in atomic units, as a decimal string (matches the coordinator). */
  amount: string;
  /** Absolute timelock as unix seconds. */
  timelock: number;
}

/** The canonical order as published by the coordinator. */
export interface ResolverOrder {
  publicId: string;
  direction: "eth_to_xlm" | "xlm_to_eth";
  hashlock: `0x${string}`;
  src: PlanLeg;
  dst: PlanLeg;
}

/** What the resolver intends to do with the order. */
export type PlanAction = "fill" | "claim";

/**
 * A resolver-built plan. It mirrors both legs of the order so that
 * every field can be diffed against the canonical order before submit.
 */
export interface ResolverPlan {
  publicId: string;
  action: PlanAction;
  hashlock: `0x${string}`;
  src: PlanLeg;
  dst: PlanLeg;
  /**
   * Absolute unix-second deadline after which this plan must not be
   * submitted. A plan built from a healthy order is valid while
   * `now <= expiresAt`; once `now > expiresAt` it is refused with
   * {@link PlanErrorCode.PlanExpired}.
   */
  expiresAt: number;
  /** Unix seconds when the plan was built (diagnostics only). */
  builtAt: number;
}

/** Stable, machine-readable rejection codes. Do not rename casually. */
export const PlanErrorCode = {
  /** Plan is consistent with the order and inside its deadline. */
  Ok: "OK",
  /** Plan targets a different order than the one being submitted. */
  OrderMismatch: "ORDER_MISMATCH",
  /** `hashlock` differs between plan and order. */
  HashlockMismatch: "HASHLOCK_MISMATCH",
  /** One of the two timelocks differs between plan and order. */
  TimelockMismatch: "TIMELOCK_MISMATCH",
  /** One of the two amounts differs between plan and order. */
  AmountMismatch: "AMOUNT_MISMATCH",
  /** One of the two assets differs between plan and order. */
  AssetMismatch: "ASSET_MISMATCH",
  /** The plan was valid when built but its timelock has since expired. */
  PlanExpired: "PLAN_EXPIRED"
} as const;

export type PlanErrorCodeValue = (typeof PlanErrorCode)[keyof typeof PlanErrorCode];

export interface PlanIssue {
  code: PlanErrorCodeValue;
  /** Dotted field path, e.g. `src.timelock`. */
  field: string;
  expected: string;
  actual: string;
}

export type PlanValidationResult =
  | { ok: true; code: typeof PlanErrorCode.Ok; issues: [] }
  | { ok: false; code: PlanErrorCodeValue; issues: PlanIssue[]; reason: string };

function issue(
  code: PlanErrorCodeValue,
  field: string,
  expected: unknown,
  actual: unknown
): PlanIssue {
  return { code, field, expected: String(expected), actual: String(actual) };
}

function compareLegs(
  kind: "src" | "dst",
  planLeg: PlanLeg,
  orderLeg: PlanLeg,
  issues: PlanIssue[]
): void {
  if (planLeg.chain !== orderLeg.chain) {
    issues.push(issue(PlanErrorCode.AssetMismatch, `${kind}.chain`, orderLeg.chain, planLeg.chain));
  }
  if (planLeg.asset !== orderLeg.asset) {
    issues.push(issue(PlanErrorCode.AssetMismatch, `${kind}.asset`, orderLeg.asset, planLeg.asset));
  }
  if (planLeg.amount !== orderLeg.amount) {
    issues.push(issue(PlanErrorCode.AmountMismatch, `${kind}.amount`, orderLeg.amount, planLeg.amount));
  }
  if (planLeg.timelock !== orderLeg.timelock) {
    issues.push(
      issue(PlanErrorCode.TimelockMismatch, `${kind}.timelock`, orderLeg.timelock, planLeg.timelock)
    );
  }
}

/**
 * Compare a plan against the canonical coordinator order and (optionally)
 * its own deadline.
 *
 * The result always carries a stable `code`. When `ok` is false the
 * `issues` array lists every mismatch found (not just the first) so an
 * operator can see the full drift in one log line.
 *
 * @param plan   The resolver-built plan.
 * @param order  The canonical order the plan claims to target.
 * @param now    Current unix seconds. Defaults to wall clock. Injecting
 *               it lets tests exercise the build-then-expire window
 *               deterministically.
 */
export function validatePlan(
  plan: ResolverPlan,
  order: ResolverOrder,
  now: number = Math.floor(Date.now() / 1000)
): PlanValidationResult {
  const issues: PlanIssue[] = [];

  if (plan.publicId !== order.publicId) {
    issues.push(issue(PlanErrorCode.OrderMismatch, "publicId", order.publicId, plan.publicId));
  }
  if (plan.hashlock.toLowerCase() !== order.hashlock.toLowerCase()) {
    issues.push(issue(PlanErrorCode.HashlockMismatch, "hashlock", order.hashlock, plan.hashlock));
  }

  compareLegs("src", plan.src, order.src, issues);
  compareLegs("dst", plan.dst, order.dst, issues);

  // The deadline check runs last so field drift is always reported
  // before an expiry, but a valid-then-expired plan is still refused.
  if (now > plan.expiresAt) {
    issues.push(
      issue(PlanErrorCode.PlanExpired, "expiresAt", `>= now (${now})`, plan.expiresAt)
    );
  }

  if (issues.length === 0) {
    return { ok: true, code: PlanErrorCode.Ok, issues: [] };
  }

  // The primary code is the first (most structural) issue; callers that
  // need finer detail can inspect `issues`.
  const primary = issues[0];
  return {
    ok: false,
    code: primary.code,
    issues,
    reason: `${primary.code}: ${primary.field} expected ${primary.expected}, got ${primary.actual}`
  };
}

/** Error thrown by {@link validatePlanForSubmit}. Carries the stable code. */
export class PlanValidationError extends Error {
  constructor(
    readonly code: PlanErrorCodeValue,
    readonly issues: PlanIssue[],
    message?: string
  ) {
    super(message ?? code);
    this.name = "PlanValidationError";
  }
}

/**
 * Re-validate a plan immediately before submitting it.
 *
 * This MUST be called at the submit boundary even if the plan already
 * passed {@link validatePlan} when it was built: on-chain state (the
 * clock in particular) moves between the two moments. Returns the plan
 * unchanged when it is still eligible, otherwise throws a
 * {@link PlanValidationError} carrying the stable code.
 */
export function validatePlanForSubmit(
  plan: ResolverPlan,
  order: ResolverOrder,
  now: number = Math.floor(Date.now() / 1000)
): ResolverPlan {
  const result = validatePlan(plan, order, now);
  if (!result.ok) {
    throw new PlanValidationError(result.code, result.issues, result.reason);
  }
  return plan;
}

/**
 * Wrap a submit callback so it can only run for a plan that is still
 * valid at the moment of submission. The callback is never invoked for
 * a mismatched or expired plan.
 */
export async function submitValidatedPlan<T>(
  plan: ResolverPlan,
  order: ResolverOrder,
  submit: (plan: ResolverPlan) => Promise<T> | T,
  now: number = Math.floor(Date.now() / 1000)
): Promise<T> {
  validatePlanForSubmit(plan, order, now);
  return submit(plan);
}

// ---------------------------------------------------------------------------
// Dry-run fill-plan validation (existing planner)
// ---------------------------------------------------------------------------

/**
 * Validate basic resolver config sanity. Returns a list of error strings
 * (empty = valid). This does NOT check connectivity — only that values
 * are present and structurally sound.
 *
 * In dry-run mode, private keys are NOT required. In live mode they are.
 */
export function validateResolverConfig(
  cfg: ResolverConfig,
  dryRun: boolean
): string[] {
  const errs: string[] = [];

  if (cfg.network !== "testnet" && cfg.network !== "mainnet") {
    errs.push(`Invalid network: ${cfg.network}`);
  }

  if (!cfg.ethereum.htlcEscrow) {
    errs.push(
      `ETH_HTLC_ESCROW contract address is not configured (set ETH_HTLC_ESCROW_TESTNET or ETH_HTLC_ESCROW_MAINNET)`
    );
  }

  if (!cfg.soroban.htlc) {
    errs.push(
      `SOROBAN_HTLC contract id is not configured (set SOROBAN_HTLC_TESTNET or SOROBAN_HTLC_MAINNET)`
    );
  }

  if (!cfg.ethereum.rpcUrl) {
    errs.push("Ethereum RPC URL is not configured");
  }

  if (!cfg.soroban.rpcUrl) {
    errs.push("Soroban RPC URL is not configured");
  }

  // Private keys are only required when NOT in dry-run.
  if (!dryRun) {
    if (!cfg.ethereum.resolverPrivateKey) {
      errs.push("RESOLVER_ETH_PRIVATE_KEY is required when dry-run is disabled");
    }
    if (!cfg.soroban.resolverSecret) {
      errs.push("RESOLVER_STELLAR_SECRET is required when dry-run is disabled");
    }
  }

  return errs;
}

/**
 * Validate the computed destination parameters for sanity.
 */
export function validateDestinationParams(
  amount: bigint,
  safetyDeposit: bigint,
  timelockSeconds: bigint
): string[] {
  const errs: string[] = [];

  if (amount <= 0n) {
    errs.push("Destination amount must be > 0");
  }

  if (safetyDeposit < 0n) {
    errs.push("Safety deposit must be >= 0");
  }

  // Mirror the on-chain MIN_TIMELOCK (300s) / MAX_TIMELOCK (24h) bounds.
  if (timelockSeconds < 300n) {
    errs.push(`Timelock (${timelockSeconds}s) is below minimum (300s)`);
  }
  if (timelockSeconds > 86400n) {
    errs.push(`Timelock (${timelockSeconds}s) exceeds maximum (86400s)`);
  }

  return errs;
}
