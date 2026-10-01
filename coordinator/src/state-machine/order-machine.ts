import type { OrderStatus } from "../persistence/orders-repo.js";

/**
 * The order lifecycle is defined once, here, as a list of named *edges*.
 * Every writer in the coordinator (the order service, the HTTP routes that
 * call it, and the Ethereum / Soroban listeners) goes through this module
 * before it touches an order, so a late or out-of-order chain event can
 * never move an order backwards or settle it twice.
 *
 * The edges, in lifecycle order:
 *
 *   escrow        announced        -> src_locked       user locks the source leg
 *   secret_relay  src_locked       -> dst_locked       resolver relays the order to the
 *                                                      destination chain and locks it
 *   secret        src_locked | dst_locked -> secret_revealed   the preimage is relayed
 *   claim         secret_revealed  -> completed        the claim is observed on chain
 *   refund        src_locked | dst_locked | secret_revealed | expired -> refunded
 *   expire        announced | src_locked | dst_locked  -> expired       timelock passed, nothing refunded yet
 *   fail          announced | src_locked | dst_locked | secret_revealed | expired -> failed
 *
 * `refund` deliberately stays reachable from `secret_revealed`: a source-leg
 * timeout after the preimage became public is a real on-chain outcome and the
 * coordinator is a *cache* of on-chain truth, so it has to be recordable.
 * The illegal refund edge is refunding an order that has already been claimed
 * (`completed`), which would mean settling the same funds twice.
 *
 * Note that the preimage may be relayed as soon as the source leg is escrowed
 * ("revealed on either side"): the destination lock is what protects the user,
 * not the reveal. What must never happen is a reveal *before* the escrow, a
 * claim before the preimage is known, or a second settlement of a claimed
 * order — all of which are refused below.
 */
export type OrderTransitionAction =
  | "escrow"
  | "secret_relay"
  | "secret"
  | "claim"
  | "refund"
  | "fail"
  | "expire";

export interface OrderEdge {
  action: OrderTransitionAction;
  /** Status the order ends up in once the edge is applied. */
  to: OrderStatus;
  /** Statuses the order may be in for this edge to be legal. */
  from: OrderStatus[];
}

/** The legal edges of the order lifecycle — the single source of truth. */
export const ORDER_EDGES: readonly OrderEdge[] = [
  { action: "escrow", to: "src_locked", from: ["announced"] },
  { action: "secret_relay", to: "dst_locked", from: ["src_locked"] },
  { action: "secret", to: "secret_revealed", from: ["src_locked", "dst_locked"] },
  { action: "claim", to: "completed", from: ["secret_revealed"] },
  {
    action: "refund",
    to: "refunded",
    from: ["src_locked", "dst_locked", "secret_revealed", "expired"]
  },
  {
    action: "fail",
    to: "failed",
    from: ["announced", "src_locked", "dst_locked", "secret_revealed", "expired"]
  },
  { action: "expire", to: "expired", from: ["announced", "src_locked", "dst_locked"] }
];

export const ORDER_STATUSES: readonly OrderStatus[] = [
  "announced",
  "src_locked",
  "dst_locked",
  "secret_revealed",
  "completed",
  "refunded",
  "failed",
  "expired"
];

function buildActionTargets(): Record<OrderTransitionAction, OrderStatus> {
  const targets = {} as Record<OrderTransitionAction, OrderStatus>;
  for (const edge of ORDER_EDGES) {
    targets[edge.action] = edge.to;
  }
  return targets;
}

/** Status each action writes when it is applied. */
export const ACTION_TARGET_STATUS: Record<OrderTransitionAction, OrderStatus> =
  buildActionTargets();

function buildActionIndex(): Record<OrderTransitionAction, OrderStatus[]> {
  const index = {} as Record<OrderTransitionAction, OrderStatus[]>;
  for (const edge of ORDER_EDGES) {
    index[edge.action] = [...edge.from];
  }
  return index;
}

/** Legal source statuses per action, lifted from `ORDER_EDGES`. */
export const LEGAL_SOURCES: Record<OrderTransitionAction, OrderStatus[]> =
  buildActionIndex();

function buildStatusIndex(): Record<OrderStatus, OrderTransitionAction | null> {
  const index = {} as Record<OrderStatus, OrderTransitionAction | null>;
  for (const status of ORDER_STATUSES) index[status] = null;
  for (const edge of ORDER_EDGES) index[edge.to] = edge.action;
  return index;
}

const ACTION_BY_TARGET: Record<OrderStatus, OrderTransitionAction | null> =
  buildStatusIndex();

function buildTransitions(): Record<OrderStatus, OrderStatus[]> {
  const table = {} as Record<OrderStatus, OrderStatus[]>;
  for (const status of ORDER_STATUSES) table[status] = [];
  for (const edge of ORDER_EDGES) {
    for (const from of edge.from) {
      table[from]!.push(edge.to);
    }
  }
  return table;
}

/**
 * Allowed transitions, derived from `ORDER_EDGES` so the table and the
 * per-action legal sources can never drift apart.
 */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = buildTransitions();

/**
 * Lifecycle rank used when chain listeners deliver events out of order.
 * Terminal outcomes intentionally rank after the happy-path states so a
 * delayed lock/reveal can never move an order backwards.
 */
const STATUS_RANK: Record<OrderStatus, number> = {
  announced: 0,
  src_locked: 1,
  dst_locked: 2,
  secret_revealed: 3,
  completed: 4,
  refunded: 4,
  failed: 4,
  expired: 4
};

/**
 * Stable, machine-readable codes for a refused transition. These strings are
 * part of the HTTP contract (see `docs/API_ERRORS.md`) — treat them as
 * append-only: never rename or reuse one.
 */
export const ORDER_FAILURE_CODES = {
  /** A preimage was relayed before the source leg was escrowed. */
  SECRET_BEFORE_ESCROW: "illegal_transition_secret_before_escrow",
  /** The destination leg was locked before the source leg was escrowed. */
  SECRET_RELAY_BEFORE_ESCROW: "illegal_transition_secret_relay_before_escrow",
  /** A claim was applied before the preimage had been recorded. */
  CLAIM_BEFORE_SECRET: "illegal_transition_claim_before_secret",
  /** A refund was applied to an already claimed (settled) order. */
  REFUND_AFTER_CLAIM: "illegal_transition_refund_after_claim",
  /** A chain event arrived after the order had already moved past it. */
  LATE_STEP: "illegal_transition_late_step",
  /** The same step was applied twice with an identical payload (idempotent). */
  REPEATED_STEP: "illegal_transition_repeated_step",
  /** The same step was applied twice with a conflicting payload. */
  CONFLICTING_STEP: "illegal_transition_conflicting_step",
  /** The order is in a terminal state and cannot be advanced again. */
  ALREADY_SETTLED: "illegal_transition_already_settled",
  /** Any other edge that is not part of the machine. */
  NOT_ALLOWED: "illegal_transition_not_allowed"
} as const;

export type OrderFailureCode =
  (typeof ORDER_FAILURE_CODES)[keyof typeof ORDER_FAILURE_CODES];

export class InvalidTransitionError extends Error {
  readonly code: OrderFailureCode;

  constructor(
    public readonly from: OrderStatus,
    public readonly to: OrderStatus,
    action: OrderTransitionAction | null = actionForStatus(to)
  ) {
    const code = classifyIllegalTransition(from, to, action);
    super(describeTransitionFailure(code, from, to));
    this.name = "InvalidTransitionError";
    this.code = code;
  }
}

/** The action that writes `status`, or null for `announced`. */
export function actionForStatus(status: OrderStatus): OrderTransitionAction | null {
  return ACTION_BY_TARGET[status];
}

/** Legal source statuses for an action. */
export function legalSourcesFor(action: OrderTransitionAction): OrderStatus[] {
  return [...LEGAL_SOURCES[action]];
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** True when `to` is an older lifecycle state than `from`. */
export function isStaleTransition(from: OrderStatus, to: OrderStatus): boolean {
  return STATUS_RANK[to] < STATUS_RANK[from];
}

/** Compare two statuses without allowing terminal states to regress. */
export function compareStatus(a: OrderStatus, b: OrderStatus): -1 | 0 | 1 {
  const left = STATUS_RANK[a];
  const right = STATUS_RANK[b];
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/**
 * Explain a refused transition with a stable code. The caller passes the
 * action when it knows it (every writer does), which lets the repeat and
 * conflict cases carry the precise code even though `to === from`.
 */
export function classifyIllegalTransition(
  from: OrderStatus,
  to: OrderStatus,
  action: OrderTransitionAction | null = actionForStatus(to)
): OrderFailureCode {
  if (action === "refund" && from === "completed") {
    return ORDER_FAILURE_CODES.REFUND_AFTER_CLAIM;
  }
  if (action === "claim" && from !== "secret_revealed") {
    return ORDER_FAILURE_CODES.CLAIM_BEFORE_SECRET;
  }
  if (action === "secret" && from === "announced") {
    return ORDER_FAILURE_CODES.SECRET_BEFORE_ESCROW;
  }
  if (action === "secret_relay" && from === "announced") {
    return ORDER_FAILURE_CODES.SECRET_RELAY_BEFORE_ESCROW;
  }
  if (isStaleTransition(from, to)) {
    return ORDER_FAILURE_CODES.LATE_STEP;
  }
  if (isTerminal(from)) {
    return ORDER_FAILURE_CODES.ALREADY_SETTLED;
  }
  if (from === to && action !== null) {
    return ORDER_FAILURE_CODES.REPEATED_STEP;
  }
  return ORDER_FAILURE_CODES.NOT_ALLOWED;
}

/** Human-readable reason for a stable failure code. */
export function describeTransitionFailure(
  code: OrderFailureCode,
  from: OrderStatus,
  to: OrderStatus
): string {
  switch (code) {
    case ORDER_FAILURE_CODES.SECRET_BEFORE_ESCROW:
      return `Refused to reveal a preimage for an order that is not escrowed yet (${from} -> ${to})`;
    case ORDER_FAILURE_CODES.SECRET_RELAY_BEFORE_ESCROW:
      return `Refused a destination lock for an order that is not escrowed yet (${from} -> ${to})`;
    case ORDER_FAILURE_CODES.CLAIM_BEFORE_SECRET:
      return `Refused a claim for an order whose preimage has not been recorded (${from} -> ${to})`;
    case ORDER_FAILURE_CODES.REFUND_AFTER_CLAIM:
      return `Refused a refund for an order that has already been claimed (${from} -> ${to})`;
    case ORDER_FAILURE_CODES.LATE_STEP:
      return `Refused a chain event that is older than the stored order status (${from} -> ${to})`;
    case ORDER_FAILURE_CODES.REPEATED_STEP:
      return `Step already applied to this order, keeping the stored status (${from})`;
    case ORDER_FAILURE_CODES.CONFLICTING_STEP:
      return `Step already applied to this order with a different payload (${from})`;
    case ORDER_FAILURE_CODES.ALREADY_SETTLED:
      return `Order is already settled as ${from} and cannot be advanced to ${to}`;
    case ORDER_FAILURE_CODES.NOT_ALLOWED:
    default:
      return `Illegal order transition: ${from} -> ${to}`;
  }
}

export interface TransitionAssessment {
  allowed: boolean;
  from: OrderStatus;
  to: OrderStatus;
  action: OrderTransitionAction | null;
  code: OrderFailureCode | null;
  reason: string | null;
}

/**
 * Decide whether an edge may be applied. Pure: it never touches storage, so
 * every writer can call it before it writes anything.
 */
export function evaluateTransition(
  from: OrderStatus,
  to: OrderStatus,
  action: OrderTransitionAction | null = actionForStatus(to)
): TransitionAssessment {
  if (canTransition(from, to)) {
    return { allowed: true, from, to, action, code: null, reason: null };
  }
  const code = classifyIllegalTransition(from, to, action);
  return {
    allowed: false,
    from,
    to,
    action,
    code,
    reason: describeTransitionFailure(code, from, to)
  };
}

export function requireTransition(
  from: OrderStatus,
  to: OrderStatus,
  action: OrderTransitionAction | null = actionForStatus(to)
): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to, action);
  }
}

export function transitionCategory(from: OrderStatus | null, to: OrderStatus): string {
  if (from === null && to === "announced") return "created";
  return to;
}
