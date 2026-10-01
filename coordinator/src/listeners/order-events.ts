import type { Logger } from "pino";
import type { Chain } from "../persistence/orders-repo.js";
import {
  OrderValidationError,
  isTransitionRejection,
  type OrderService
} from "../services/order-service.js";
import type { OrderFailureCode } from "../state-machine/order-machine.js";

/**
 * Chain-agnostic bridge event.
 *
 * Both listeners decode their own wire format into this shape and hand it to
 * `OrderEventApplier`, so the Ethereum and Soroban paths cannot drift into two
 * different sets of rules: the edge that an event maps to is decided here, and
 * the state machine decides whether it is legal.
 */
export type BridgeEventKind = "lock" | "claim" | "refund";

export interface BridgeOrderEvent {
  kind: BridgeEventKind;
  /** Chain that emitted the event. */
  chain: Chain;
  txHash: string;
  /** Block number (EVM) or ledger sequence (Soroban). */
  blockNumber: number;
  /** On-chain order id, as a decimal string. */
  orderId?: string | null;
  /** Hashlock carried by creation events. */
  hashlock?: string | null;
  /** Absolute unix seconds carried by creation events. */
  timelock?: number | null;
  /** Preimage carried by claim events. */
  preimage?: string | null;
}

export type BridgeEventOutcome =
  /** Step applied, or already applied — redelivery is idempotent. */
  | { status: "applied"; publicId: string }
  /** Nothing to do: no matching order, or the event lacked required fields. */
  | { status: "ignored"; reason: string }
  /** The state machine refused the edge; the order status is unchanged. */
  | { status: "rejected"; publicId: string; code: OrderFailureCode; message: string }
  /** Unexpected failure while applying; the caller should log and carry on. */
  | { status: "error"; message: string };

/**
 * Applies decoded chain events to the order book.
 *
 * Listeners are passive observers of chains that can redeliver events, reorg,
 * or deliver them out of order. This class therefore never throws for a
 * refused event: the refusal is already persisted with its stable code by the
 * order service, and the listener just logs it and keeps polling.
 */
export class OrderEventApplier {
  constructor(
    private readonly orders: OrderService,
    private readonly log: Logger,
    /** Label recorded next to every refused transition. */
    private readonly writer: string
  ) {}

  async apply(event: BridgeOrderEvent): Promise<BridgeEventOutcome> {
    try {
      switch (event.kind) {
        case "lock":
          return await this.applyLock(event);
        case "claim":
          return await this.applyClaim(event);
        case "refund":
          return await this.applyRefund(event);
      }
    } catch (err) {
      if (isTransitionRejection(err)) {
        return {
          status: "rejected",
          publicId: err.publicId,
          code: err.code,
          message: err.message
        };
      }
      if (err instanceof OrderValidationError) {
        // A rule other than the state machine refused the event (for example
        // the timelock ordering guard). Nothing was written.
        return { status: "ignored", reason: err.message };
      }
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }

  /**
   * A creation event on either chain.
   *
   * The chain that emitted it decides the edge: a lock on the order's source
   * chain is the escrow, a lock on its destination chain is the resolver's
   * secret relay. Getting this wrong (recording every Ethereum lock as a
   * source lock) is what made late `OrderCreated` logs clobber destination
   * legs.
   */
  private async applyLock(event: BridgeOrderEvent): Promise<BridgeEventOutcome> {
    const hashlock = event.hashlock?.toLowerCase();
    if (!hashlock) {
      return { status: "ignored", reason: "lock event without a hashlock" };
    }
    const order = await this.orders.findByHashlock(hashlock);
    if (!order) {
      return { status: "ignored", reason: "no local order for this hashlock" };
    }
    if (event.timelock == null) {
      return { status: "ignored", reason: "lock event without a timelock" };
    }
    if (!event.orderId) {
      return { status: "ignored", reason: "lock event without an order id" };
    }

    if (event.chain === order.srcChain) {
      await this.orders.recordSrcLock({
        publicId: order.publicId,
        orderId: event.orderId,
        txHash: event.txHash,
        blockNumber: event.blockNumber,
        timelock: event.timelock,
        writer: this.writer
      });
    } else {
      await this.orders.recordDstLock({
        publicId: order.publicId,
        orderId: event.orderId,
        txHash: event.txHash,
        blockNumber: event.blockNumber,
        timelock: event.timelock,
        resolver: null,
        writer: this.writer
      });
    }
    return { status: "applied", publicId: order.publicId };
  }

  /**
   * A claim observed on either chain.
   *
   * Claim events carry the preimage, so the relay is applied first (the
   * `secret` edge) and the settlement second (the `claim` edge). An order
   * whose escrow has not been observed yet is refused rather than settled:
   * that is the "claim before the secret" rule.
   */
  private async applyClaim(event: BridgeOrderEvent): Promise<BridgeEventOutcome> {
    const order = await this.resolveOrder(event);
    if (!order) {
      return { status: "ignored", reason: "no local order for this on-chain id" };
    }

    const preimage = event.preimage?.toLowerCase();
    if (preimage && order.preimage !== preimage) {
      await this.orders.recordSecret(order.publicId, preimage, event.txHash, this.writer);
    }
    await this.orders.recordClaim({
      publicId: order.publicId,
      txHash: event.txHash,
      writer: this.writer
    });
    return { status: "applied", publicId: order.publicId };
  }

  private async applyRefund(event: BridgeOrderEvent): Promise<BridgeEventOutcome> {
    const order = await this.resolveOrder(event);
    if (!order) {
      return { status: "ignored", reason: "no local order for this on-chain id" };
    }
    await this.orders.recordRefund({
      publicId: order.publicId,
      txHash: event.txHash,
      writer: this.writer
    });
    return { status: "applied", publicId: order.publicId };
  }

  /**
   * An on-chain id can be the source or the destination leg of an order. When
   * the emitter does not give us an id we recognise (for example a claim on an
   * order whose locks we never observed), the hashlock carried by the event is
   * the fallback, so the attempt is still attributed and refused instead of
   * being silently dropped.
   */
  private async resolveOrder(event: BridgeOrderEvent) {
    if (event.orderId) {
      const asSource = await this.orders.findBySrcOrderId(event.chain, event.orderId);
      if (asSource) return asSource;
      const asDestination = await this.orders.findByDstOrderId(event.chain, event.orderId);
      if (asDestination) return asDestination;
    }
    if (event.hashlock) {
      return this.orders.findByHashlock(event.hashlock.toLowerCase());
    }
    return null;
  }

  /** Log an outcome at the level that operationally matters. */
  logOutcome(event: BridgeOrderEvent, outcome: BridgeEventOutcome): void {
    const fields = {
      kind: event.kind,
      chain: event.chain,
      txHash: event.txHash,
      blockNumber: event.blockNumber
    };
    switch (outcome.status) {
      case "applied":
        this.log.debug({ ...fields, publicId: outcome.publicId }, "chain event applied");
        return;
      case "rejected":
        this.log.warn(
          { ...fields, publicId: outcome.publicId, code: outcome.code },
          "chain event refused by the order state machine"
        );
        return;
      case "error":
        this.log.error({ ...fields, err: outcome.message }, "chain event could not be applied");
        return;
      case "ignored":
      default:
        this.log.debug({ ...fields, reason: outcome.reason }, "chain event ignored");
    }
  }
}
