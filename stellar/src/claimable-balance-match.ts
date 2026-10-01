/**
 * @fileoverview Claimable balance escrow matching for OverSync
 * @description Loads a claimable balance from Horizon (recorded JSON in tests) and
 * verifies that its id, asset, amount, and claimants match the order escrow BEFORE
 * a claim transaction is built. A swapped or foreign balance id must never reach a
 * `claimClaimableBalance` operation.
 */

import { Asset } from '@stellar/stellar-sdk';

/** Canonical network id used by the SDK asset mappings ("testnet" | "mainnet"). */
export type BalanceMatchNetwork = 'testnet' | 'mainnet';

/** Normalized terms of the order's Stellar-side escrow. */
export interface EscrowTerms {
  /** Canonical Stellar asset the order pays out: 'XLM' or CODE:ISSUER. */
  asset: string;
  /** Payout amount in Stellar 7-decimal precision (e.g. "10.0000000"). */
  amount: string;
  /** Account the balance must be claimable by. */
  claimant: string;
}

/**
 * Runtime view of a Horizon `GET /claimable_balances/{id}` response
 * (only the fields needed for matching are declared).
 */
export interface ClaimableBalanceRecord {
  id: string;
  asset: string | { asset_type: string; asset_code?: string; asset_issuer?: string };
  amount: string;
  claimants: Array<{ destination: string; predicate?: Record<string, unknown> }>;
  claimed?: boolean;
}

/** Raw balance JSON as recorded from Horizon, before normalization. */
export type RecordedBalanceJson = Record<string, unknown>;

/** Result of loading a balance id through the Horizon loader. */
export type LoadedBalanceResult =
  | { status: 'found'; balance: ClaimableBalanceRecord }
  | { status: 'not_found' };

/** How to load a claimable balance (injectable for recorded-JSON tests). */
export interface BalanceLoader {
  loadBalance(balanceId: string): Promise<LoadedBalanceResult>;
}

/** Error codes for {@link BalanceMismatchError}. */
export type BalanceMismatchReason =
  | 'not_found'
  | 'already_claimed'
  | 'asset_mismatch'
  | 'amount_mismatch'
  | 'claimant_mismatch';

/**
 * Thrown when a balance id does not describe the order's escrow, or the balance
 * is unavailable for claiming. Message is stable and intentionally carries no
 * order secret material (preimages, hash hex, signature payloads).
 */
export class BalanceMismatchError extends Error {
  readonly code: BalanceMismatchReason;
  readonly balanceId?: string;

  constructor(code: BalanceMismatchReason, balanceId?: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BalanceMismatchError';
    this.code = code;
    this.balanceId = balanceId;
  }
}

/** Format a Horizon asset (native or issued) as a canonical 'XLM' or 'CODE:ISSUER' string. */
export function canonicalAssetString(
  asset: string | { asset_type: string; asset_code?: string; asset_issuer?: string }
): string {
  if (typeof asset === 'string') {
    return asset === 'native' ? 'XLM' : asset;
  }
  if (asset.asset_type === 'native') return 'XLM';
  if (!asset.asset_code || !asset.asset_issuer) {
    throw new BalanceMismatchError(
      'asset_mismatch',
      undefined,
      'balance record has an issued asset without code or issuer'
    );
  }
  return `${asset.asset_code}:${asset.asset_issuer}`;
}

/** Build the escrow terms an order expects on the Stellar side. */
export function buildEscrowTerms(input: {
  assetCode: string;
  assetIssuer?: string;
  amount: string;
  claimant: string;
  network?: BalanceMatchNetwork;
}): EscrowTerms {
  const network = input.network ?? 'testnet';
  let asset: string;
  if (input.assetCode === 'XLM') {
    asset = 'XLM';
  } else {
    if (!input.assetIssuer) {
      throw new BalanceMismatchError(
        'asset_mismatch',
        undefined,
        `issued asset ${input.assetCode} requires an issuer`
      );
    }
    const sdkAsset = new Asset(input.assetCode, input.assetIssuer);
    if (network === 'mainnet') {
      if (sdkAsset.isNative()) asset = 'XLM';
      else asset = `${input.assetCode}:${input.assetIssuer}`;
    } else {
      asset = sdkAsset.toString();
    }
  }

  const parsed = Number(input.amount);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BalanceMismatchError('amount_mismatch', undefined, `amount is not a positive number: ${input.amount}`);
  }
  if (!input.claimant || input.claimant.length !== 56 || !input.claimant.startsWith('G')) {
    throw new BalanceMismatchError('claimant_mismatch', undefined, 'claimant must be a 56-character Stellar account id (G...)');
  }

  return {
    asset,
    amount: parsed.toFixed(7),
    claimant: input.claimant,
  };
}

/** Normalize a recorded/raw Horizon balance JSON into the runtime shape. */
export function normalizeBalanceRecord(raw: RecordedBalanceJson): ClaimableBalanceRecord {
  const record = raw as {
    id?: unknown;
    asset?: unknown;
    amount?: unknown;
    claimants?: unknown;
    claimed?: unknown;
  };
  if (
    typeof record.id !== 'string' ||
    record.asset === undefined ||
    typeof record.amount !== 'string' ||
    !Array.isArray(record.claimants)
  ) {
    throw new BalanceMismatchError(
      'not_found',
      undefined,
      'balance record is malformed (missing id, asset, amount, or claimants)'
    );
  }

  const claimants = (record.claimants as unknown[]).map((c) => {
    const destination = (c as { destination?: unknown })?.destination;
    if (typeof destination !== 'string') {
      throw new BalanceMismatchError('not_found', undefined, 'balance record has a claimant without a destination');
    }
    const predicate = (c as { predicate?: Record<string, unknown> }).predicate;
    return { destination, ...(predicate ? { predicate } : {}) };
  });

  return {
    id: record.id,
    asset: record.asset as ClaimableBalanceRecord['asset'],
    amount: record.amount,
    claimants,
    // Horizon only sets `claimed` on balances that have already been claimed;
    // carry it through or the already-claimed refusal can never fire.
    ...(typeof record.claimed === 'boolean' ? { claimed: record.claimed } : {}),
  };
}

/**
 * Compare a loaded balance against the order's escrow terms.
 * Order: id (already bound by the load) → claimed → asset → amount → claimant.
 */
export function verifyBalanceMatchesEscrow(
  balance: ClaimableBalanceRecord,
  terms: EscrowTerms
): void {
  if (balance.claimed === true) {
    throw new BalanceMismatchError('already_claimed', balance.id);
  }

  const balanceAsset = canonicalAssetString(balance.asset);
  if (balanceAsset !== terms.asset) {
    throw new BalanceMismatchError(
      'asset_mismatch',
      balance.id,
      `balance asset ${balanceAsset} != escrow asset ${terms.asset}`
    );
  }

  const balanceAmount = Number(balance.amount);
  if (!Number.isFinite(balanceAmount) || balanceAmount.toFixed(7) !== terms.amount) {
    throw new BalanceMismatchError(
      'amount_mismatch',
      balance.id,
      `balance amount ${balance.amount} != escrow amount ${terms.amount}`
    );
  }

  const destinations = balance.claimants.map((c) => c.destination);
  if (!destinations.includes(terms.claimant)) {
    throw new BalanceMismatchError(
      'claimant_mismatch',
      balance.id,
      `claimant ${terms.claimant} is not among balance claimants`
    );
  }
}

/**
 * Load and fully verify a balance against escrow terms.
 * This is the gate every claim path must pass BEFORE building a claim tx.
 */
export async function loadAndVerifyBalance(
  balanceId: string,
  terms: EscrowTerms,
  loader: BalanceLoader
): Promise<ClaimableBalanceRecord> {
  if (!balanceId || typeof balanceId !== 'string') {
    throw new BalanceMismatchError('not_found', balanceId, 'balance id is empty');
  }

  let loaded: LoadedBalanceResult;
  try {
    loaded = await loader.loadBalance(balanceId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BalanceMismatchError('not_found', balanceId, `Horizon lookup failed: ${detail}`);
  }

  if (loaded.status === 'not_found') {
    throw new BalanceMismatchError('not_found', balanceId);
  }

  try {
    verifyBalanceMatchesEscrow(loaded.balance, terms);
  } catch (error) {
    if (error instanceof BalanceMismatchError) {
      throw new BalanceMismatchError(error.code, balanceId, error.message.slice(error.code.length + 2));
    }
    throw error;
  }

  return loaded.balance;
}
