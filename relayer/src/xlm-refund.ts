/**
 * Permissionless XLM refund helper for failed XLM→ETH swaps.
 *
 * Lives outside index.ts so it can be reused by:
 *  - the `/api/orders/xlm-to-eth` error handler (immediate refund),
 *  - the `/api/orders/manual-refund` endpoint (user-initiated),
 *  - the background watchdog (rescues orders the user never retried).
 *
 * The function is intentionally side-effect-light: it only builds, signs and
 * (optionally) submits a Stellar payment. Order book bookkeeping is left to
 * callers.
 *
 * `prepareXlmRefund` is the piece that makes hash-first submission possible:
 * it stops *before* the network call and hands back the signed transaction,
 * whose hash is computable locally. Callers pass that to
 * `stageStellarTransaction()` so the relay submission tracker can persist the
 * hash before the payment is ever submitted.
 */

export type RefundNetworkMode = 'mainnet' | 'testnet';

export interface RefundXlmArgs {
  /** Order id used in the refund memo (truncated to fit Stellar's 28-byte text memo). */
  orderId: string;
  /** Destination Stellar address receiving the refunded XLM. */
  stellarAddress: string;
  /** Hash of the user's original XLM payment to the relayer (used to size the refund). */
  stellarTxHash?: string;
  /** `mainnet` for Stellar Public, `testnet` otherwise. */
  networkMode: RefundNetworkMode;
  /** Horizon endpoint to use for the chosen network. */
  horizonUrl: string;
  /** Stellar secret to sign the refund. Should be the relayer's hot wallet. */
  refundSecret: string;
  /**
   * Fallback amount (decimal XLM string) used when the original payment
   * cannot be looked up — e.g. the watchdog firing before Horizon has
   * indexed the user's tx. Optional.
   */
  fallbackXlmAmount?: string;
}

export interface RefundXlmResult {
  hash: string;
  amount: string;
  ledger?: number;
}

/** A signed, but not yet submitted, refund payment. */
export interface PreparedXlmRefund {
  /**
   * Signed Stellar transaction. `hash()` yields the local transaction hash,
   * which is what makes hash-first submission possible. Typed loosely because
   * the SDK is loaded dynamically and the concrete class is not needed here.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction: any;
  /** Amount the refund will pay, in XLM. */
  amount: string;
}

/**
 * Build and sign the refund payment without submitting it.
 *
 * The amount is derived from the user's original payment (minus a dust margin
 * for the refund's own fee) and falls back to the order amount, or to a
 * conservative 0.1 XLM stub when neither is available.
 */
export async function prepareXlmRefund(args: RefundXlmArgs): Promise<PreparedXlmRefund> {
  const { Horizon, Keypair, Asset, Operation, TransactionBuilder, Networks, BASE_FEE, Memo } =
    await import('@stellar/stellar-sdk');

  const server = new Horizon.Server(args.horizonUrl);
  const keypair = Keypair.fromSecret(args.refundSecret);
  const account = await server.loadAccount(keypair.publicKey());

  let refundAmount =
    args.fallbackXlmAmount && Number(args.fallbackXlmAmount) > 0
      ? args.fallbackXlmAmount
      : '0.1';

  if (args.stellarTxHash) {
    try {
      const ops = await server.operations().forTransaction(args.stellarTxHash).call();
      const paymentOp: any = ops.records.find(
        (op: any) =>
          op.type === 'payment' && op.to === keypair.publicKey() && op.asset_type === 'native'
      );
      if (paymentOp) {
        const original = parseFloat(paymentOp.amount);
        // Leave a tiny dust margin for the refund tx's own fee.
        refundAmount = Math.max(original - 0.0001, 0).toFixed(7);
      }
    } catch (lookupErr) {
      console.warn('[xlm-refund] Original tx lookup failed, using fallback amount:', lookupErr);
    }
  }

  const networkPassphrase = args.networkMode === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
  const payment = Operation.payment({
    destination: args.stellarAddress,
    asset: Asset.native(),
    amount: refundAmount,
  });

  const memoText = `Refund:${(args.orderId || 'unknown').substring(0, 20)}`;
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(payment)
    .addMemo(Memo.text(memoText))
    .setTimeout(300)
    .build();

  tx.sign(keypair);
  return { transaction: tx, amount: refundAmount };
}

/**
 * Submit a refund payment on Stellar. Throws on any error — callers
 * decide whether to surface, retry, or just log it.
 *
 * Prefer `prepareXlmRefund` + `stageStellarTransaction` + the relay submission
 * tracker: that path records the transaction hash before the payment is
 * broadcast, so an ambiguous submit can never become a second refund.
 */
export async function refundXlmToUser(args: RefundXlmArgs): Promise<RefundXlmResult> {
  const prepared = await prepareXlmRefund(args);
  const { Horizon } = await import('@stellar/stellar-sdk');
  const server = new Horizon.Server(args.horizonUrl);
  const result: any = await server.submitTransaction(prepared.transaction);
  return {
    hash: result.hash,
    amount: prepared.amount,
    ledger: result.ledger,
  };
}
