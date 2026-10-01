/**
 * Background watchdog that rescues XLM→ETH orders the relayer failed to
 * complete (typically because the user closed the page after sending
 * XLM, or the ETH RPC hiccupped past the in-request retry budget).
 *
 * Every `intervalMs` we walk `activeOrders`, find any `xlm_to_eth` order
 * that has been awaiting ETH for longer than `staleAfterMs`, and trigger
 * a refund through the **relay submission tracker** — the same door the
 * request handlers use. That matters: the watchdog used to be a second,
 * independent refund path, so it could pay a refund for an order whose ETH
 * release was still in flight and later land, paying the user twice. The
 * tracker's order-level lock refuses the refund in exactly that case, and
 * the shared (orderId, side, action) key means a watchdog refund and an
 * inline refund for the same order can only ever produce one transaction.
 *
 * The watchdog is best-effort: failures are logged but never thrown so
 * one bad order can't take down the entire timer.
 */

import { prepareXlmRefund, type PreparedXlmRefund, type RefundNetworkMode } from './xlm-refund.js';
import {
  RelayOrderBusyError,
  RelayTerminalError,
  RelayConfirmationTimeoutError,
  type RelayAction,
  type RelaySide,
  type RelayStager,
  type RelaySubmissionTracker,
} from './relay-submission-tracker.js';
import { stageStellarTransaction, type HorizonServer } from './relay-submission-port.js';

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_STALE_AFTER_MS = 5 * 60_000; // 5 minutes

interface WatchdogOrder {
  orderId?: string;
  direction?: string;
  status?: string;
  stellarAddress?: string;
  stellarTxHash?: string;
  xlmReceivedAt?: number | string;
  created?: number | string;
  amount?: number | string;
  networkMode?: RefundNetworkMode | string;
  refundTxHash?: string;
  refundedAt?: number;
  ethTxHash?: string;
  watchdogFailedAt?: number;
  watchdogFailureReason?: string;
  [k: string]: unknown;
}

export interface WatchdogConfig {
  /** How often to scan, in ms. Defaults to 60s. */
  intervalMs?: number;
  /**
   * How long an order can sit without ETH being sent before the
   * watchdog refunds it. Defaults to 5 minutes.
   */
  staleAfterMs?: number;
  /** Horizon URL for the active Stellar network (mainnet or testnet). */
  horizonUrl: string;
  /** Stellar secret the relayer will sign refunds with. */
  refundSecret: string;
  /** Network mode used to choose the right passphrase. */
  networkMode: RefundNetworkMode;
  /**
   * Reference to the in-memory order map maintained by the relayer.
   * The watchdog mutates entries in-place to mark them refunded.
   */
  activeOrders: Map<string, WatchdogOrder>;
  /**
   * The single shared submission door. Required: the watchdog must never
   * broadcast a refund outside the tracker's order-level single-flight lock.
   */
  tracker: RelaySubmissionTracker;
  /**
   * Builds and signs the refund payment without submitting it. Injected so the
   * watchdog can be exercised without a live chain.
   */
  prepareRefund?: typeof prepareXlmRefund;
  /** Builds the Horizon server used to broadcast. Injected for tests. */
  createHorizonServer?: (horizonUrl: string) => HorizonServer | Promise<HorizonServer>;
}

function toMillis(value: WatchdogOrder['xlmReceivedAt'] | WatchdogOrder['created']): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isXlmToEthAwaitingEth(order: WatchdogOrder): boolean {
  if (order.direction !== 'xlm_to_eth') return false;
  if (!order.stellarTxHash) return false; // XLM never received → nothing to refund
  if (order.refundTxHash || order.refundedAt) return false; // already refunded
  if (order.status === 'eth_tx_sent' || order.status === 'completed') return false;
  if (order.status === 'refunded') return false;
  return true;
}

/**
 * Build the tracker action for an order's refund. The key is
 * (orderId, side, action), so a watchdog refund and an inline refund for the
 * same order are the *same* submission rather than two competing ones.
 */
export function watchdogRefundAction(
  orderId: string,
  order: WatchdogOrder,
  networkMode: RefundNetworkMode
): RelayAction {
  return {
    orderId: order.orderId || orderId,
    side: 'xlm_to_eth' as RelaySide,
    action: 'refund',
    chain: 'stellar',
    network: (order.networkMode as string) || networkMode,
    amount: order.amount != null ? String(order.amount) : undefined,
    extra: { source: 'refund-watchdog', stellarTxHash: order.stellarTxHash },
  };
}

export interface RefundWatchdogHandle {
  stop: () => void;
  /** Run one scan immediately. Exposed for tests and manual reconciliation. */
  scan: () => Promise<void>;
}

export function startRefundWatchdog(config: WatchdogConfig): RefundWatchdogHandle {
  const intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
  const staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const prepareRefund = config.prepareRefund ?? prepareXlmRefund;
  const createHorizonServer: NonNullable<WatchdogConfig['createHorizonServer']> =
    config.createHorizonServer ??
    (async (horizonUrl: string) => {
      // Loaded lazily so the SDK is only pulled in when a refund is due.
      const { Horizon } = await import('@stellar/stellar-sdk');
      return new Horizon.Server(horizonUrl);
    });

  console.log(
    `[refund-watchdog] starting · scan every ${Math.round(intervalMs / 1000)}s · refund after ${Math.round(staleAfterMs / 1000)}s · network=${config.networkMode}`
  );

  const scan = async (): Promise<void> => {
    const now = Date.now();
    for (const [orderId, order] of config.activeOrders.entries()) {
      try {
        if (!isXlmToEthAwaitingEth(order)) continue;
        if (order.watchdogFailedAt && now - order.watchdogFailedAt < 10 * 60_000) {
          // back off for 10 minutes after a failed attempt
          continue;
        }

        const startedAt = toMillis(order.xlmReceivedAt) ?? toMillis(order.created);
        if (!startedAt) continue;
        const age = now - startedAt;
        if (age < staleAfterMs) continue;

        const stellarAddress = order.stellarAddress;
        if (!stellarAddress) {
          console.warn(`[refund-watchdog] order ${orderId} stuck but missing stellarAddress; skipping`);
          continue;
        }

        const action = watchdogRefundAction(orderId, order, config.networkMode);

        // The claim/release for this order may still be in flight. Ask the
        // tracker before doing any work so we never race a live submission.
        const blocking = config.tracker.getBlockingRecord(action);
        if (blocking) {
          console.warn(
            `[refund-watchdog] ⏸ order ${orderId} has an in-flight ${blocking.action.action} submission ` +
              `(${blocking.status}${blocking.txHash ? `, tx ${blocking.txHash}` : ''}); refusing refund`
          );
          continue;
        }

        console.log(
          `[refund-watchdog] refunding ${orderId} — pending for ${Math.round(age / 1000)}s, stellarTx=${order.stellarTxHash}`
        );

        // Same (orderId, side, action) triple as the inline refund handler, so
        // the tracker guarantees a single refund transaction per order.
        const stager: RelayStager<{ hash?: string }> = async () => {
          const prepared: PreparedXlmRefund = await prepareRefund({
            orderId: action.orderId,
            stellarAddress,
            stellarTxHash: order.stellarTxHash,
            networkMode: config.networkMode,
            horizonUrl: config.horizonUrl,
            refundSecret: config.refundSecret,
            fallbackXlmAmount: order.amount ? String(order.amount) : undefined,
          });
          // The signed payment's hash is known locally, so the tracker can
          // persist it before the broadcast.
          return stageStellarTransaction<{ hash?: string }>({
            server: await createHorizonServer(config.horizonUrl),
            transaction: prepared.transaction,
            network: action.network as string,
            label: 'refund-watchdog',
          });
        };

        const submission = await config.tracker.submit(action, stager);
        const result = submission.result;
        const refundHash = submission.txHash ?? result?.hash;
        if (typeof refundHash !== 'string' || refundHash.length === 0) {
          throw new Error('refund submission returned no transaction hash');
        }

        order.status = 'refunded';
        order.refundTxHash = refundHash;
        order.refundedAt = Date.now();
        delete order.watchdogFailedAt;
        console.log(
          `[refund-watchdog] ✅ refunded order ${orderId} (tx=${refundHash}, ${submission.status})`
        );
      } catch (err: unknown) {
        const message = (err as { message?: string })?.message ?? String(err);

        if (err instanceof RelayOrderBusyError) {
          // Expected and healthy: another action owns this order.
          console.warn(`[refund-watchdog] ⏸ order ${orderId} skipped: ${message}`);
          continue;
        }
        if (err instanceof RelayTerminalError) {
          // The refund is known-dead; retrying would just burn the budget.
          console.error(`[refund-watchdog] ❌ refund for ${orderId} failed terminally: ${message}`);
          continue;
        }
        if (err instanceof RelayConfirmationTimeoutError) {
          // A refund transaction exists but is unconfirmed. The tracker still
          // holds the order lock, so the next scan reconciles that same hash.
          console.warn(
            `[refund-watchdog] ⏳ refund for ${orderId} unconfirmed (tx ${err.txHash}); will reconcile`
          );
          continue;
        }

        order.watchdogFailedAt = Date.now();
        order.watchdogFailureReason = message;
        console.error(`[refund-watchdog] ❌ failed to refund ${orderId}:`, message);
      }
    }
  };

  const tick = () => {
    void scan();
  };

  // Fire-and-forget first scan after a short warm-up so the watchdog
  // doesn't race with relayer startup logic.
  const warmup = setTimeout(tick, 15_000);
  const handle = setInterval(tick, intervalMs);

  return {
    scan,
    stop() {
      clearTimeout(warmup);
      clearInterval(handle);
    },
  };
}
