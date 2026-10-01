/**
 * @fileoverview Chain adapters that make relay submissions hash-first.
 *
 * `relay-submission-tracker.ts` requires a two-phase submission: the caller
 * must be able to name the transaction hash *before* the transaction can reach
 * a node, so the tracker can persist it and reconcile instead of re-broadcasting.
 *
 * Both chains support that natively:
 *  - Stellar: the hash is `sha256(signature base)`. It does not depend on the
 *    signatures, so it is available the moment the envelope is built.
 *  - Ethereum: the hash is `keccak256(signed payload)`, so we sign locally and
 *    broadcast the raw transaction ourselves instead of letting the provider
 *    sign-and-send behind an opaque promise.
 *
 * Everything else in the relayer should submit through here so that the
 * tracker stays the only door.
 */

import type { StagedSubmission, RelayConfirmation, RelayConfirmationRef } from './relay-submission-tracker.js';

/** Anything with a Stellar `Transaction.hash()` (Transaction or FeeBumpTransaction). */
interface HashableStellarTransaction {
  hash(): Buffer;
}

/** Horizon's `Horizon.Server`, narrowed to the calls we make. */
export type HorizonServer = {
  transactions(): { transaction(hash: string): { call(): Promise<any> } };
  operations(): { forTransaction(hash: string): { call(): Promise<any> } };
  loadAccount(accountId: string): Promise<any>;
  submitTransaction(tx: any): Promise<any>;
};

export interface StellarStagingOptions {
  server: HorizonServer;
  transaction: HashableStellarTransaction;
  network: string;
  /** Memo/label used in log lines only. */
  label?: string;
}

/**
 * Stage a Stellar transaction. The hash is derived locally from the envelope,
 * so the tracker can persist it before `server.submitTransaction` is called.
 */
export function stageStellarTransaction<R = any>(
  options: StellarStagingOptions
): StagedSubmission<R> {
  const { server, transaction, network } = options;
  // `hash()` is the signature base digest — the same value Horizon reports.
  const txHash = Buffer.from(transaction.hash()).toString('hex');
  if (!txHash) {
    throw new Error('stellar transaction hash could not be computed locally');
  }
  return {
    txHash,
    network,
    broadcast: () => server.submitTransaction(transaction) as Promise<R>,
  };
}

export interface EthereumStagingOptions {
  /** Signer with network access (e.g. `new ethers.Wallet(pk, provider)`). */
  wallet: { signTransaction(tx: any): Promise<string>; address?: string };
  /** Provider used only to broadcast and to await the receipt. */
  provider: { broadcastTransaction(raw: string): Promise<any> };
  /** A populated (unsigned) ethers transaction request. */
  request: Record<string, any>;
  network: string;
  /**
   * How many times a rate-limited *broadcast* is retried. Default 3. The retry
   * re-sends the identical signed payload, so the transaction hash never
   * changes and no second transaction is created.
   */
  maxBroadcastRetries?: number;
  /** Base backoff between broadcast retries in ms. Default 1000. */
  broadcastRetryDelayMs?: number;
  /** Injectable sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

function isRateLimitError(err: unknown): boolean {
  const anyErr = err as {
    code?: string | number;
    message?: string;
    error?: { code?: string | number; message?: string };
  };
  if (anyErr?.code === 429 || anyErr?.error?.code === 429) return true;
  const text = `${anyErr?.message ?? ''} ${anyErr?.error?.message ?? ''}`.toLowerCase();
  return (
    text.includes('rate limit') ||
    text.includes('compute units') ||
    text.includes('exceeded') ||
    text.includes('429')
  );
}

/**
 * Stage an Ethereum transaction by signing locally. The transaction hash is
 * `keccak256(signed payload)`, which is exactly the hash the node will report,
 * so it can be persisted before the broadcast.
 *
 * Async because signing may resolve a nonce. Signatures are local, so nothing
 * here puts the transaction on-chain.
 */
export async function stageEthereumTransaction<R = any>(
  options: EthereumStagingOptions
): Promise<StagedSubmission<R>> {
  const {
    wallet,
    provider,
    request,
    network,
    maxBroadcastRetries = 3,
    broadcastRetryDelayMs = 1_000,
    sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
  } = options;
  const { keccak256 } = await import('ethers');
  // Signed once, here. Every broadcast below re-sends this exact payload, so a
  // rate-limit retry can never produce a second transaction.
  const rawTx = await wallet.signTransaction(request);
  const txHash = keccak256(rawTx);
  if (!txHash) {
    throw new Error('ethereum transaction hash could not be computed locally');
  }

  const broadcast = async (): Promise<R> => {
    let sent: any;
    for (let attempt = 0; attempt <= maxBroadcastRetries; attempt++) {
      try {
        sent = await provider.broadcastTransaction(rawTx);
        break;
      } catch (err) {
        if (attempt >= maxBroadcastRetries || !isRateLimitError(err)) throw err;
        await sleep(broadcastRetryDelayMs * Math.pow(2, attempt));
      }
    }
    if (!sent) throw new Error(`ethereum broadcast for ${txHash} did not return a response`);
    return (await sent.wait()) as R;
  };

  return { txHash, network, broadcast };
}

export interface RelayConfirmerDeps {
  /** Resolve a Horizon server for a network (`mainnet` / `testnet`). */
  getStellarServer: (network?: string) => HorizonServer | Promise<HorizonServer>;
  /** Resolve an ethers provider for a network. */
  getEthereumProvider: (network?: string) => Promise<any>;
}

function isNotFound(err: unknown): boolean {
  const anyErr = err as { response?: { status?: number }; status?: number; statusCode?: number };
  const status = anyErr?.response?.status ?? anyErr?.status ?? anyErr?.statusCode;
  return status === 404;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Chain-agnostic confirmation lookup for the tracker.
 *
 * Contract: never throw. A hash the node has never seen is `not_found` (it may
 * still be propagating), a hash the node knows but has not settled is
 * `pending`, and a settled transaction is `succeeded` or `failed`.
 */
export function createRelayConfirmer(deps: RelayConfirmerDeps) {
  return async function confirm(ref: RelayConfirmationRef): Promise<RelayConfirmation> {
    if (ref.chain === 'stellar') return confirmStellar(ref, deps);
    if (ref.chain === 'ethereum') return confirmEthereum(ref, deps);
    // Unknown chain: refuse to guess. Staying `pending` keeps the order locked,
    // which is the safe direction.
    return { state: 'pending', error: `no confirmer configured for chain ${ref.chain}` };
  };
}

async function confirmStellar(
  ref: RelayConfirmationRef,
  deps: RelayConfirmerDeps
): Promise<RelayConfirmation> {
  let server: HorizonServer;
  try {
    server = await deps.getStellarServer(ref.network);
  } catch (err) {
    return { state: 'pending', error: `horizon unavailable: ${messageOf(err)}` };
  }
  try {
    const tx = await server.transactions().transaction(ref.txHash).call();
    if (tx && tx.successful === false) {
      return {
        state: 'failed',
        error: `stellar tx failed on ledger (result codes: ${JSON.stringify(tx.result_codes ?? {})})`,
        result: tx,
      };
    }
    return { state: 'succeeded', result: tx };
  } catch (err) {
    if (isNotFound(err)) return { state: 'not_found' };
    // Horizon hiccups are not evidence of a dead transaction.
    return { state: 'pending', error: messageOf(err) };
  }
}

async function confirmEthereum(
  ref: RelayConfirmationRef,
  deps: RelayConfirmerDeps
): Promise<RelayConfirmation> {
  let provider: any;
  try {
    provider = await deps.getEthereumProvider(ref.network);
  } catch (err) {
    return { state: 'pending', error: `eth provider unavailable: ${messageOf(err)}` };
  }
  try {
    const receipt = await provider.getTransactionReceipt(ref.txHash);
    if (receipt) {
      if (receipt.status === 1 || receipt.status === undefined) {
        return { state: 'succeeded', result: receipt };
      }
      return { state: 'failed', error: `evm tx reverted (status ${receipt.status})`, result: receipt };
    }
  } catch (err) {
    return { state: 'pending', error: messageOf(err) };
  }
  try {
    const tx = await provider.getTransaction(ref.txHash);
    if (tx) return { state: 'pending' };
    return { state: 'not_found' };
  } catch (err) {
    if (isNotFound(err)) return { state: 'not_found' };
    return { state: 'pending', error: messageOf(err) };
  }
}
