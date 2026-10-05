import type { Logger } from "pino";
import { z } from "zod";
import {
  OrdersRepository,
  type OrderRow,
  type OrderSnapshot,
  type OrderRejectedTransition,
  type AnnounceOrderInput,
  type OrderMetrics,
  type OrderTransitionSummary,
  type Direction,
  type Chain,
  type OrderStatus
} from "../persistence/orders-repo.js";
import {
  ACTION_TARGET_STATUS,
  ORDER_FAILURE_CODES,
  actionForStatus,
  describeTransitionFailure,
  evaluateTransition,
  type OrderFailureCode,
  type OrderTransitionAction
} from "../state-machine/order-machine.js";
import { illegalOrderTransitions, ordersTotal } from "../metrics.js";
import {
  QuoteService,
  QuoteExpiredError,
  QuoteNotFoundError,
  QuoteAmountMismatchError,
  QuoteTermsMismatchError
} from "./quote-service.js";
import { loadConfig } from "../config.js";
import {
  validateTimelocksAtCreation,
  type TimelockValidationError
} from "../utils/timelock-validator.js";

/**
 * Minimal interface the coordinator uses to verify that an Ethereum
 * address is currently registered in the on-chain ResolverRegistry.
 * Kept as a port so the service layer stays free of ethers / viem.
 */
export interface ResolverRegistryPort {
  /** Returns true if `address` is currently active in the registry. */
  isActive(address: string): Promise<boolean>;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASHLOCK = "0x" + "0".repeat(64);
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

/** Page size used when a caller asks for history without naming a limit. */
const DEFAULT_HISTORY_LIMIT = 50;

export const announceSchema = z.object({
  direction: z.enum(["eth_to_xlm", "xlm_to_eth"]),
  hashlock: z.string().regex(HEX32, "hashlock must be 0x + 64 hex chars").refine(
    (v) => v.toLowerCase() !== ZERO_HASHLOCK.toLowerCase(),
    "hashlock must not be all zeros"
  ),
  srcChain: z.enum(["ethereum", "stellar"]),
  srcAddress: z.string(),
  srcAsset: z.string().min(1),
  srcAmount: z.string().regex(/^\d+$/, "srcAmount must be a decimal integer string"),
  srcSafetyDeposit: z.string().regex(/^\d+$/, "srcSafetyDeposit must be a decimal integer string"),
  dstChain: z.enum(["ethereum", "stellar"]),
  dstAddress: z.string(),
  dstAsset: z.string().min(1),
  dstAmount: z.string().regex(/^\d+$/, "dstAmount must be a decimal integer string"),
  /**
   * Optional: the `quoteId` returned by `GET /api/quotes/eth-xlm`.
   * When present, the coordinator validates that the quote has not
   * expired before accepting the announcement, ensuring fills cannot
   * be based on stale pricing.
   */
  quoteId: z.string().optional()
});

export type AnnounceInput = z.infer<typeof announceSchema>;

/**
 * Codes an `OrderValidationError` can carry: the timelock ordering codes and
 * the stable order state machine failure codes.
 */
export type OrderErrorCode = TimelockValidationError | OrderFailureCode;

export class OrderValidationError extends Error {
  readonly code?: OrderErrorCode;

  constructor(message: string, code?: TimelockValidationError) {
    super(message);
    this.name = "OrderValidationError";
    this.code = code;
  }
}

/**
 * A quote-gated announce refusal. Extends `OrderValidationError` so service
 * callers see a validation error, while the HTTP route maps `quoteCode` to
 * the stable `quote_expired` / `quote_mismatch` contract.
 */
export class QuoteGateError extends OrderValidationError {
  readonly quoteCode: "quote_expired" | "quote_mismatch";

  constructor(quoteCode: QuoteGateError["quoteCode"], message: string) {
    super(message);
    this.name = "QuoteGateError";
    this.quoteCode = quoteCode;
  }
}

function assertTimelocksAtCreation(
  srcTimelock: number,
  dstTimelock: number,
  minGapSeconds: number
): void {
  const validation = validateTimelocksAtCreation(srcTimelock, dstTimelock, minGapSeconds);
  if (!validation.isValid && validation.error) {
    const message =
      validation.error === "TIMELOCKS_REVERSED"
        ? "Destination timelock must be strictly before source timelock"
        : "Timelock gap between source and destination is below the minimum safety gap";
    throw new OrderValidationError(message, validation.error);
  }
}

/** A chain event was validly shaped but older than the persisted state. */
export class StaleOrderEventError extends OrderValidationError {
  constructor(message: string) {
    super(message);
    this.name = "StaleOrderEventError";
  }
}

export interface TransitionRejectionInfo {
  from: OrderStatus;
  to: OrderStatus;
  action: OrderTransitionAction | null;
  code: OrderFailureCode;
  reason: string;
  writer: string;
  publicId: string;
  txHash?: string | null;
}

/**
 * Thrown when a writer asks the coordinator to move an order along an edge the
 * state machine refuses. The attempt has already been persisted as a refused
 * transition at this point and the stored status is untouched.
 *
 * It extends `StaleOrderEventError` because a late chain event is exactly what
 * a rejected transition usually is, and existing callers rely on that.
 */
export class OrderTransitionRejectedError extends StaleOrderEventError {
  readonly code: OrderFailureCode;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly action: OrderTransitionAction | null;
  readonly writer: string;
  readonly publicId: string;

  constructor(info: TransitionRejectionInfo) {
    super(info.reason);
    this.name = "OrderTransitionRejectedError";
    this.code = info.code;
    this.from = info.from;
    this.to = info.to;
    this.action = info.action;
    this.writer = info.writer;
    this.publicId = info.publicId;
  }
}

/** True when the error is a refusal produced by the order state machine. */
export function isTransitionRejection(err: unknown): err is OrderTransitionRejectedError {
  return err instanceof OrderTransitionRejectedError;
}

function validateChainAddress(chain: Chain, addr: string): void {
  if (chain === "ethereum" && !HEX_ADDRESS.test(addr)) {
    throw new OrderValidationError(`${addr} is not a valid Ethereum address`);
  }
  if (chain === "stellar" && !STELLAR_ADDRESS.test(addr)) {
    throw new OrderValidationError(`${addr} is not a valid Stellar account`);
  }
}

function validateDirectionAgainstChains(input: AnnounceInput): void {
  const expected: Record<Direction, { src: Chain; dst: Chain }> = {
    eth_to_xlm: { src: "ethereum", dst: "stellar" },
    xlm_to_eth: { src: "stellar", dst: "ethereum" }
  };
  const want = expected[input.direction];
  if (want.src !== input.srcChain || want.dst !== input.dstChain) {
    throw new OrderValidationError(
      `Direction ${input.direction} requires src=${want.src} and dst=${want.dst}`
    );
  }
}

/**
 * One request to move an order along one legal edge.
 *
 * `advance()` is the only place the coordinator writes order status, so the
 * rule that decides whether an edge is legal (the state machine) is applied to
 * every writer: the order service itself, the HTTP routes that call it, the
 * secret service and both chain listeners.
 */
interface AdvanceRequest {
  publicId: string;
  action: OrderTransitionAction;
  txHash?: string | null;
  writer?: string;
  /**
   * When the order is already in the target status: does the incoming event
   * carry exactly the payload that is already stored? Identical payloads are
   * treated as an idempotent redelivery, anything else as a conflict.
   */
  isSameStep?: (order: OrderRow) => boolean;
  logMessage: string;
  logFields?: Record<string, unknown>;
  apply: (order: OrderRow, to: OrderStatus) => Promise<void>;
}

export class OrderService {
  private readonly minGapSeconds: number;

  constructor(
    private readonly repo: OrdersRepository,
    private readonly log: Logger,
    /** Optional — when supplied, quoteId in announce requests is validated. */
    private readonly quoteService?: QuoteService,
    config?: ReturnType<typeof loadConfig>,
    /** Optional — when supplied, buildClaim validates resolver registration. */
    private readonly resolverRegistry?: ResolverRegistryPort
  ) {
    this.minGapSeconds = config?.timelockSafetyGapSeconds ?? 600;
  }

  /**
   * Record a new order announcement. The coordinator does NOT lock any
   * funds — it simply records the intent so the order book is visible
   * to all resolvers and the user can later attach the on-chain
   * `srcOrderId` once they have locked.
   *
   * When `quoteId` is present in the input, it is validated against
   * the QuoteService before the order is persisted.  Expired or
   * unknown quoteIds are rejected as `OrderValidationError` so the
   * error surfaces cleanly to the caller before any chain action is
   * attempted.
   */
  async announce(input: AnnounceInput): Promise<OrderRow> {
    validateChainAddress(input.srcChain, input.srcAddress);
    validateChainAddress(input.dstChain, input.dstAddress);
    validateDirectionAgainstChains(input);

    if (input.hashlock.toLowerCase() === ZERO_HASHLOCK.toLowerCase()) {
      throw new OrderValidationError("hashlock must not be all zeros");
    }

    const hashlock = input.hashlock.toLowerCase() as `0x${string}`;

    // --- Quote freshness gate -------------------------------------------
    if (input.quoteId) {
      if (!this.quoteService) {
        // No QuoteService wired in (e.g. test mode without quotes) — skip.
        this.log.debug({ quoteId: input.quoteId }, "quoteId supplied but no QuoteService wired; skipping freshness check");
      } else {
        // Quote errors surface as `QuoteGateError` (an `OrderValidationError`
        // subclass) so service callers see a validation error while the HTTP
        // route maps `quoteCode` to the stable contract.
        try {
          const bound = this.quoteService.bindOrderTerms(input.quoteId, {
            fromAsset: input.srcAsset,
            toAsset: input.dstAsset,
            amount: input.srcAmount,
            fromNetwork: input.srcChain,
            toNetwork: input.dstChain
          });
          // The quote was issued for concrete terms: amount or network drift
          // must be rejected before any order is persisted.
          if (
            (bound.srcAmount !== undefined &&
              bound.srcAmount !== "0" &&
              input.srcAmount !== bound.srcAmount) ||
            (bound.amountBaseUnits !== undefined && input.srcAmount !== bound.amountBaseUnits)
          ) {
            throw new QuoteGateError(
              "quote_mismatch",
              `Order srcAmount ${input.srcAmount} does not match quoted amount`
            );
          }
          if (
            (bound.srcChain !== undefined && input.srcChain !== bound.srcChain) ||
            (bound.dstChain !== undefined && input.dstChain !== bound.dstChain) ||
            (bound.srcAsset !== undefined && input.srcAsset !== bound.srcAsset) ||
            (bound.dstAsset !== undefined && input.dstAsset !== bound.dstAsset) ||
            (bound.dstAmount !== undefined &&
              bound.dstAmount !== "0" &&
              input.dstAmount !== bound.dstAmount)
          ) {
            throw new QuoteGateError("quote_mismatch", `Order terms do not match quote ${input.quoteId}`);
          }
          this.log.debug({ quoteId: input.quoteId }, "quote freshness confirmed");
        } catch (err) {
          if (err instanceof QuoteGateError) throw err;
          if (err instanceof QuoteExpiredError || err instanceof QuoteNotFoundError) {
            throw new QuoteGateError("quote_expired", err.message);
          }
          if (err instanceof QuoteAmountMismatchError || err instanceof QuoteTermsMismatchError) {
            throw new QuoteGateError("quote_mismatch", err.message);
          }
          throw err;
        }
      }
    }
    // -------------------------------------------------------------------

    const existing = await this.repo.findByHashlock(hashlock);
    if (existing) {
      throw new OrderValidationError(
        `An order with hashlock ${hashlock} already exists (publicId=${existing.publicId})`
      );
    }

    // Strip quoteId — it's not a persisted column, just a freshness gate.
    const { quoteId: _q, ...repoInput } = input;
    const order = await this.repo.announce({ ...repoInput, hashlock } as AnnounceOrderInput);
    this.log.info(
      { publicId: order.publicId, direction: order.direction, quoteId: input.quoteId ?? null },
      "order announced"
    );
    ordersTotal.inc({ status: "announced" });
    return order;
  }

  get(publicId: string): Promise<OrderRow | null> {
    return this.repo.findByPublicId(publicId);
  }
  /**
   * Cursor-based history page. `before` is the validated keyset from the
   * previous page; omit it for the first page. `limit` defaults to a full page
   * so a bare `history(address)` still works for non-paginated callers.
   */
  history(
    address: string,
    limit = DEFAULT_HISTORY_LIMIT,
    before?: { createdAt: number; publicId: string }
  ): Promise<OrderRow[]> {
    return this.repo.findByAddressPage(address, limit, before);
  }

  getTransitions(publicId: string): Promise<OrderTransitionSummary[]> {
    return this.repo.getTransitions(publicId);
  }

  findByHashlock(hashlock: string): Promise<OrderRow | null> {
    return this.repo.findByHashlock(hashlock);
  }

  findByPreimage(preimage: string): Promise<OrderRow | null> {
    return this.repo.findByPreimage(preimage);
  }

  /** Match an on-chain id that belongs to the order's source leg. */
  findBySrcOrderId(chain: Chain, orderId: string): Promise<OrderRow | null> {
    return this.repo.findBySrcOrderId(chain, orderId);
  }

  /** Match an on-chain id that belongs to the order's destination leg. */
  findByDstOrderId(chain: Chain, orderId: string): Promise<OrderRow | null> {
    return this.repo.findByDstOrderId(chain, orderId);
  }

  /** Source leg escrowed on chain (`escrow` edge). */
  async recordSrcLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
    writer?: string;
  }): Promise<void> {
    await this.advance({
      publicId: input.publicId,
      action: "escrow",
      txHash: input.txHash,
      writer: input.writer,
      isSameStep: (order) =>
        order.srcOrderId === input.orderId &&
        order.srcLockTx === input.txHash &&
        order.srcLockBlock === input.blockNumber &&
        order.srcTimelock === input.timelock,
      logMessage: "src lock recorded",
      logFields: { srcOrderId: input.orderId },
      apply: async (order) => {
        if (order.dstTimelock != null) {
          assertTimelocksAtCreation(input.timelock, order.dstTimelock, this.minGapSeconds);
        }
        await this.repo.recordSrcLock({
          publicId: input.publicId,
          orderId: input.orderId,
          txHash: input.txHash,
          blockNumber: input.blockNumber,
          timelock: input.timelock
        });
      }
    });
  }

  /** Destination leg locked by a resolver (`secret_relay` edge). */
  async recordDstLock(input: {
    publicId: string;
    orderId: string;
    txHash: string;
    blockNumber: number;
    timelock: number;
    resolver: string | null;
    writer?: string;
  }): Promise<void> {
    await this.advance({
      publicId: input.publicId,
      action: "secret_relay",
      txHash: input.txHash,
      writer: input.writer,
      isSameStep: (order) =>
        order.dstOrderId === input.orderId &&
        order.dstLockTx === input.txHash &&
        order.dstLockBlock === input.blockNumber &&
        order.dstTimelock === input.timelock &&
        order.resolverAddress === input.resolver,
      logMessage: "dst lock recorded",
      logFields: { dstOrderId: input.orderId },
      apply: async (order) => {
        if (order.srcTimelock != null) {
          assertTimelocksAtCreation(order.srcTimelock, input.timelock, this.minGapSeconds);
        }
        await this.repo.recordDstLock({
          publicId: input.publicId,
          orderId: input.orderId,
          txHash: input.txHash,
          blockNumber: input.blockNumber,
          timelock: input.timelock,
          resolver: input.resolver
        });
      }
    });
  }

  /**
   * The single writer for every lifecycle edge. Validates the edge with the
   * state machine, persists refused attempts with a stable code, and treats
   * an identical redelivery as idempotent.
   */
  private async advance(req: AdvanceRequest): Promise<void> {
    const order = await this.repo.findByPublicId(req.publicId);
    if (!order) throw new OrderValidationError(`unknown order ${req.publicId}`);
    const to = ACTION_TARGET_STATUS[req.action];
    const writer = req.writer ?? "order-service";
    const txHash = req.txHash ?? null;

    const assessment = evaluateTransition(order.status, to, req.action);
    if (assessment.allowed) {
      await req.apply(order, to);
      this.log.info(
        { publicId: req.publicId, from: order.status, to, ...(req.logFields ?? {}) },
        req.logMessage
      );
      ordersTotal.inc({ status: to });
      return;
    }

    // Already in the target status: identical payload = idempotent redelivery,
    // anything else = conflicting repeat.
    if (order.status === to) {
      if (req.isSameStep?.(order)) {
        await this.repo.recordRejectedTransition({
          publicId: req.publicId,
          from: order.status,
          to,
          action: req.action,
          code: ORDER_FAILURE_CODES.REPEATED_STEP,
          reason: describeTransitionFailure(ORDER_FAILURE_CODES.REPEATED_STEP, order.status, to),
          txHash,
          writer
        });
        illegalOrderTransitions.inc({ code: ORDER_FAILURE_CODES.REPEATED_STEP });
        return;
      }
      const code = ORDER_FAILURE_CODES.CONFLICTING_STEP;
      await this.repo.recordRejectedTransition({
        publicId: req.publicId,
        from: order.status,
        to,
        action: req.action,
        code,
        reason: describeTransitionFailure(code, order.status, to),
        txHash,
        writer
      });
      illegalOrderTransitions.inc({ code });
      throw new OrderTransitionRejectedError({
        from: order.status,
        to,
        action: req.action,
        code,
        reason: describeTransitionFailure(code, order.status, to),
        writer,
        publicId: req.publicId,
        txHash
      });
    }

    const code = assessment.code ?? ORDER_FAILURE_CODES.NOT_ALLOWED;
    const reason = assessment.reason ?? describeTransitionFailure(code, order.status, to);
    await this.repo.recordRejectedTransition({
      publicId: req.publicId,
      from: order.status,
      to,
      action: req.action,
      code,
      reason,
      txHash,
      writer
    });
    illegalOrderTransitions.inc({ code });
    throw new OrderTransitionRejectedError({
      from: order.status,
      to,
      action: req.action,
      code,
      reason,
      writer,
      publicId: req.publicId,
      txHash
    });
  }

  async recordSecret(
    publicId: string,
    preimage: string,
    txHash: string,
    writer?: string
  ): Promise<void> {
    await this.advance({
      publicId,
      action: "secret",
      txHash,
      writer,
      isSameStep: (order) => order.preimage === preimage,
      logMessage: "secret recorded",
      apply: async () => {
        await this.repo.recordSecretRevealed({ publicId, preimage, txHash });
      }
    });
  }

  async recordClaim(
    input: { publicId: string; txHash: string; writer?: string }
  ): Promise<void> {
    await this.advance({
      publicId: input.publicId,
      action: "claim",
      txHash: input.txHash,
      writer: input.writer,
      isSameStep: () => true,
      logMessage: "claim recorded",
      logFields: { txHash: input.txHash },
      apply: async () => {
        await this.repo.setStatus(input.publicId, "completed", input.txHash);
      }
    });
  }

  async recordRefund(
    inputOrPublicId: { publicId: string; txHash: string; writer?: string } | string,
    txHash?: string,
    writer?: string
  ): Promise<void> {
    const input =
      typeof inputOrPublicId === "string"
        ? { publicId: inputOrPublicId, txHash: txHash ?? "", writer }
        : inputOrPublicId;
    await this.advance({
      publicId: input.publicId,
      action: "refund",
      txHash: input.txHash,
      writer: input.writer,
      isSameStep: () => true,
      logMessage: "refund recorded",
      logFields: { txHash: input.txHash },
      apply: async () => {
        await this.repo.setStatus(input.publicId, "refunded", input.txHash);
      }
    });
  }

  async getRejectedTransitions(publicId: string) {
    return this.repo.getRejectedTransitions(publicId);
  }

  async getOrderMetrics(): Promise<OrderMetrics> {
    return this.repo.getMetrics();
  }

  async markStatus(publicId: string, status: OrderStatus, writer?: string): Promise<void> {
    const action = actionForStatus(status);
    if (action === null) {
      throw new OrderValidationError(`${status} is not the target of a lifecycle edge`);
    }
    await this.advance({
      publicId,
      action,
      writer,
      isSameStep: () => true,
      logMessage: "status updated",
      apply: async () => {
        await this.repo.setStatus(publicId, status);
      }
    });
  }

  async getSnapshots(): Promise<OrderSnapshot[]> {
    return this.repo.getCompletedOrderSnapshots();
  }

  /**
   * Validate that the coordinator may build a claim transaction for
   * `orderId` on behalf of `resolverAddress`.
   *
   * Throws `OrderValidationError` when:
   *  - The order does not exist or is not in a claimable state.
   *  - The resolver registry is configured and the resolver address is
   *    not currently active (never registered, or removed).
   *
   * Returns the order row so the caller can assemble the transaction
   * without a second DB round-trip.
   */
  async buildClaim(orderId: string, resolverAddress: string): Promise<OrderRow> {
    const order = await this.repo.findByPublicId(orderId);
    if (!order) throw new OrderValidationError(`unknown order ${orderId}`);

    if (order.status !== "dst_locked") {
      throw new OrderValidationError(
        `order ${orderId} is not in dst_locked state (current: ${order.status})`
      );
    }

    if (this.resolverRegistry) {
      const active = await this.resolverRegistry.isActive(resolverAddress);
      if (!active) {
        throw new OrderValidationError(
          `resolver ${resolverAddress} is not registered or has been removed from the registry`
        );
      }
      this.log.debug({ orderId, resolverAddress }, "resolver registry check passed");
    }

    return order;
  }
}

export class LegacyLockError extends Error {
  constructor() {
    super("legacy lock refused");
    this.name = "LegacyLockError";
  }
}

/** Use the v2 escrow when it is configured. A legacy-bridge target builds nothing. */
export function resolveLockTarget(input: {
  v2Escrow?: string | null;
  requestedTarget: string;
  legacyBridge: string;
}): { target: string } {
  const v2 = (input.v2Escrow ?? "").trim();
  if (!v2) return { target: input.requestedTarget };
  if (input.requestedTarget.toLowerCase() === input.legacyBridge.toLowerCase()) {
    throw new LegacyLockError();
  }
  return { target: v2 };
}