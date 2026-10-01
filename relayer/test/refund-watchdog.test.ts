import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startRefundWatchdog, watchdogRefundAction } from "../src/refund-watchdog.js";
import {
  RelaySubmissionTracker,
  RelayOrderBusyError,
  type RelayAction,
} from "../src/relay-submission-tracker.js";

/**
 * The watchdog is exercised with an injected refund builder and Horizon server,
 * so nothing here touches a live chain. `globalThis.fetch` is replaced with a
 * throwing spy to prove it.
 */

const HOUR = 60 * 60 * 1000;

/** Minimal stand-in for a signed Stellar transaction. */
function fakeTransaction(hash: string) {
  return { hash: () => Buffer.from(hash, 'hex') };
}

function stuckOrder(over: Record<string, unknown> = {}) {
  return {
    direction: 'xlm_to_eth',
    status: 'awaiting_eth_release',
    stellarAddress: 'GUSER',
    stellarTxHash: 'aa'.repeat(32),
    xlmReceivedAt: Date.now() - 2 * HOUR,
    amount: 12.5,
    networkMode: 'testnet',
    ...over,
  };
}

describe("watchdogRefundAction", () => {
  it("keys the refund by order id, side and action so every refund path shares one slot", () => {
    const action = watchdogRefundAction('order_1', stuckOrder(), 'testnet');
    expect(action).toMatchObject({
      orderId: 'order_1',
      side: 'xlm_to_eth',
      action: 'refund',
      chain: 'stellar',
      network: 'testnet',
    });
  });

  it("prefers the order's own id over the map key", () => {
    const action = watchdogRefundAction('map-key', stuckOrder({ orderId: 'order_real' }), 'testnet');
    expect(action.orderId).toBe('order_real');
  });
});

describe("startRefundWatchdog", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;
  let tracker: RelaySubmissionTracker;
  let submitted: any[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn(() => {
      throw new Error("the watchdog must not touch the network directly");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    submitted = [];
    tracker = new RelaySubmissionTracker({ sleep: () => Promise.resolve() });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function harness(
    orders: Map<string, any>,
    overrides: Partial<Parameters<typeof startRefundWatchdog>[0]> = {}
  ) {
    const prepareRefund = vi.fn(async ({ orderId }: { orderId: string }) => ({
      transaction: fakeTransaction('bb'.repeat(32)),
      amount: '12.4',
      orderId,
    }));
    const submitTransaction = vi.fn(async () => ({ hash: 'bb'.repeat(32) }));
    const watchdog = startRefundWatchdog({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'S-test',
      networkMode: 'testnet',
      activeOrders: orders,
      tracker,
      prepareRefund: prepareRefund as never,
      createHorizonServer: () => ({ submitTransaction }) as never,
      ...overrides,
    });
    return { watchdog, prepareRefund, submitTransaction };
  }

  it("refunds a stale order through the tracker and stamps the result", async () => {
    const orders = new Map<string, any>([['order_1', stuckOrder()]]);
    const { watchdog, prepareRefund, submitTransaction } = harness(orders);

    await watchdog.scan();
    watchdog.stop();

    expect(prepareRefund).toHaveBeenCalledTimes(1);
    expect(submitTransaction).toHaveBeenCalledTimes(1);
    const order = orders.get('order_1');
    expect(order.status).toBe('refunded');
    expect(order.refundTxHash).toBe('bb'.repeat(32));
    expect(order.refundedAt).toBeGreaterThan(0);

    // The refund is visible to every other door for this order.
    const record = tracker.getRecord(watchdogRefundAction('order_1', order, 'testnet'));
    expect(record?.status).toBe('succeeded');
    expect(record?.action).toMatchObject({ side: 'xlm_to_eth', action: 'refund' });
  });

  it("skips orders that are fresh, already refunded, or never received XLM", async () => {
    const orders = new Map<string, any>([
      ['fresh', stuckOrder({ xlmReceivedAt: Date.now() - 1000 })],
      ['done', stuckOrder({ status: 'refunded' })],
      ['eth_sent', stuckOrder({ status: 'eth_tx_sent' })],
      ['no_xlm', stuckOrder({ stellarTxHash: undefined })],
      ['wrong_direction', stuckOrder({ direction: 'eth_to_xlm' })],
      ['stale', stuckOrder()],
    ]);
    const { watchdog, prepareRefund } = harness(orders, { orderId: undefined } as never);

    await watchdog.scan();
    watchdog.stop();

    expect(prepareRefund).toHaveBeenCalledTimes(1);
    expect(prepareRefund.mock.calls[0][0].orderId).toBe('stale');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to refund while a claim for the same order is pending", async () => {
    const orders = new Map<string, any>([['order_1', stuckOrder()]]);
    const { watchdog, prepareRefund } = harness(orders);

    // A claim for this order is in flight and its hash is already recorded.
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const claimPromise = tracker
      .submit(
        {
          orderId: 'order_1',
          side: 'xlm_to_eth',
          action: 'claim',
          chain: 'ethereum',
          network: 'sepolia',
        } satisfies RelayAction,
        () => ({
          txHash: '0xclaim',
          network: 'sepolia',
          broadcast: vi.fn(async () => {
            await gate;
            return { hash: '0xclaim' };
          }),
        })
      )
      .catch(() => undefined);
    await vi.waitFor(() => expect(tracker.getRecord({ orderId: 'order_1', side: 'xlm_to_eth', action: 'claim', chain: 'ethereum' })?.txHash).toBe('0xclaim'));

    await watchdog.scan();
    watchdog.stop();
    release();
    await claimPromise;

    // Nothing was signed or broadcast for the refund.
    expect(prepareRefund).not.toHaveBeenCalled();
    expect(orders.get('order_1').status).toBe('awaiting_eth_release');
  });

  it("refuses a refund that arrives after the claim settled", async () => {
    const orders = new Map<string, any>([['order_1', stuckOrder()]]);
    const { watchdog, prepareRefund } = harness(orders);

    await tracker.submit(
      { orderId: 'order_1', side: 'xlm_to_eth', action: 'claim', chain: 'ethereum', network: 'sepolia' },
      () => ({ txHash: '0xclaim', network: 'sepolia', broadcast: vi.fn(async () => ({ hash: '0xclaim' })) })
    );

    await watchdog.scan();
    watchdog.stop();

    expect(prepareRefund).not.toHaveBeenCalled();
    expect(orders.get('order_1').refundTxHash).toBeUndefined();
  });

  it("only ever produces one refund when two doors race for the same order", async () => {
    const orders = new Map<string, any>([['order_1', stuckOrder()]]);
    const { watchdog, prepareRefund, submitTransaction } = harness(orders);

    // The inline handler and the watchdog resolve to the same tracker key.
    const inlineAction = watchdogRefundAction('order_1', orders.get('order_1'), 'testnet');
    const [inline, watchdogRun] = await Promise.all([
      tracker.submit(
        inlineAction,
        () => ({
          txHash: 'cc'.repeat(32),
          network: 'testnet',
          broadcast: vi.fn(async () => ({ hash: 'cc'.repeat(32) })),
        })
      ),
      watchdog.scan(),
    ]);

    watchdog.stop();
    expect(inline.txHash).toBe('cc'.repeat(32));
    // The watchdog joined the running refund instead of signing its own.
    expect(prepareRefund).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
    expect(tracker.getStats().broadcasts).toBe(1);
  });

  it("reconciles an unconfirmed refund instead of signing a second one", async () => {
    const orders = new Map<string, any>([['order_1', stuckOrder()]]);
    // A confirmer that keeps reporting the refund as pending models a Horizon
    // that accepted the payment but has not indexed it yet.
    const tracker = new RelaySubmissionTracker({
      sleep: () => Promise.resolve(),
      maxAttempts: 2,
      timeoutMs: 10,
      confirm: async () => ({ state: 'pending' }),
    });
    const submitTransaction = vi.fn(() => new Promise(() => {}));
    const prepareRefund = vi.fn(async () => ({
      transaction: fakeTransaction('bb'.repeat(32)),
      amount: '12.4',
    }));
    const watchdog = startRefundWatchdog({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'S-test',
      networkMode: 'testnet',
      activeOrders: orders,
      tracker,
      prepareRefund: prepareRefund as never,
      createHorizonServer: () => ({ submitTransaction }) as never,
    });

    await watchdog.scan();
    expect(prepareRefund).toHaveBeenCalledTimes(1);
    expect(submitTransaction).toHaveBeenCalledTimes(1);
    // The order is not stamped as refunded, and no failure backoff is armed:
    // the refund is simply still in flight.
    expect(orders.get('order_1').status).toBe('awaiting_eth_release');
    expect(orders.get('order_1').watchdogFailedAt).toBeUndefined();

    // The next scan reconciles the same hash instead of building a new refund.
    await watchdog.scan();
    watchdog.stop();
    expect(prepareRefund).toHaveBeenCalledTimes(1);
    expect(submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("skips an order that failed inside the backoff window", async () => {
    const orders = new Map<string, any>([
      ['order_1', stuckOrder({ watchdogFailedAt: Date.now() - 60_000, watchdogFailureReason: 'earlier' })],
    ]);
    const { watchdog, prepareRefund } = harness(orders);

    await watchdog.scan();
    watchdog.stop();
    expect(prepareRefund).not.toHaveBeenCalled();
  });

  it("retries after a pre-broadcast failure and still refunds exactly once", async () => {
    const orders = new Map<string, any>([['order_1', stuckOrder()]]);
    let attempt = 0;
    const prepareRefund = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error('horizon down while loading the account');
      return { transaction: fakeTransaction('bb'.repeat(32)), amount: '12.4' };
    });
    const submitTransaction = vi.fn(async () => ({ hash: 'bb'.repeat(32) }));
    const watchdog = startRefundWatchdog({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      refundSecret: 'S-test',
      networkMode: 'testnet',
      activeOrders: orders,
      tracker,
      prepareRefund: prepareRefund as never,
      createHorizonServer: () => ({ submitTransaction }) as never,
    });

    await watchdog.scan();
    // Nothing was signed or sent, so no failure backoff is armed and the next
    // tick is free to try again.
    expect(submitTransaction).not.toHaveBeenCalled();
    expect(orders.get('order_1').watchdogFailedAt).toBeUndefined();

    await watchdog.scan();
    watchdog.stop();

    expect(prepareRefund).toHaveBeenCalledTimes(2);
    expect(submitTransaction).toHaveBeenCalledTimes(1);
    expect(orders.get('order_1').status).toBe('refunded');
  });

  it("leaves a terminally failed refund alone instead of retrying forever", async () => {
    const orders = new Map<string, any>([['order_1', stuckOrder()]]);
    const { watchdog, prepareRefund } = harness(orders);

    // Simulate a previous run that ended in a terminal failure.
    tracker.submit(
      watchdogRefundAction('order_1', orders.get('order_1'), 'testnet'),
      () => {
        throw new Error('op_underfunded');
      }
    ).catch(() => undefined);

    await watchdog.scan();
    watchdog.stop();

    expect(prepareRefund).not.toHaveBeenCalled();
    // No backoff timer: the tracker already refused, and the next scan should
    // surface the refusal rather than hide it behind a 10 minute wait.
    expect(orders.get('order_1').watchdogFailedAt).toBeUndefined();
  });

  it("surfaces RelayOrderBusyError to the caller as a skip, not a failure", async () => {
    const orders = new Map<string, any>([['order_1', stuckOrder()]]);
    const { watchdog } = harness(orders);

    // The order lock is taken by another action between the watchdog's guard
    // and its submission (e.g. a concurrent request handler).
    const blocking = {
      key: 'xlm_to_eth:claim:order_1#deadbeef',
      orderKey: 'order_1|xlm_to_eth#deadbeef',
      action: { orderId: 'order_1', side: 'xlm_to_eth', action: 'claim', chain: 'ethereum' },
      status: 'pending',
      attempts: 1,
      maxAttempts: 3,
      broadcasts: 1,
      txHash: '0xclaim',
      firstSeenAt: 1,
    } as never;
    tracker.submit = vi.fn(async () => {
      throw new RelayOrderBusyError(
        watchdogRefundAction('order_1', orders.get('order_1'), 'testnet'),
        blocking
      );
    }) as never;
    tracker.getBlockingRecord = vi.fn(() => undefined) as never;

    await expect(watchdog.scan()).resolves.toBeUndefined();
    watchdog.stop();
    expect(orders.get('order_1').watchdogFailedAt).toBeUndefined();
  });

  it("stops its timer", async () => {
    const orders = new Map<string, any>();
    const { watchdog, prepareRefund } = harness(orders, { intervalMs: 5, staleAfterMs: 0 });
    await watchdog.scan();
    watchdog.stop();
    const callsAfterStop = prepareRefund.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(prepareRefund.mock.calls.length).toBe(callsAfterStop);
  });
});
