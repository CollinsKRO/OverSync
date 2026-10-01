/**
 * @fileoverview Escrow matching rules for claimable balances (issue #267).
 * @description Every case replays recorded Horizon JSON from test/fixtures —
 * no live Horizon call is made.
 */

import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  BalanceMismatchError,
  buildEscrowTerms,
  canonicalAssetString,
  loadAndVerifyBalance,
  normalizeBalanceRecord,
  verifyBalanceMatchesEscrow,
} from '../src/claimable-balance.js';
import type { BalanceLoader, RecordedBalanceJson } from '../src/claimable-balance.js';
import { loadFixture } from './support/horizon-replay.js';
import {
  BENEFICIARY,
  FOREIGN_BALANCE_ID,
  ORDER_BALANCE_ID,
  PREIMAGE,
  USDC_ISSUER,
  usdcEscrowTerms,
} from './support/escrow.js';

/** Loader that replays one recorded balance for any id it is asked about. */
function replayingLoader(record: RecordedBalanceJson | null): BalanceLoader {
  return {
    async loadBalance() {
      return record === null
        ? { status: 'not_found' }
        : { status: 'found', balance: normalizeBalanceRecord(record) };
    },
  };
}

async function rejection(
  balanceId: string,
  record: RecordedBalanceJson | null,
  terms = usdcEscrowTerms()
): Promise<BalanceMismatchError> {
  try {
    await loadAndVerifyBalance(balanceId, terms, replayingLoader(record));
  } catch (error) {
    if (error instanceof BalanceMismatchError) return error;
    throw error;
  }
  throw new Error('expected the balance to be rejected');
}

describe('buildEscrowTerms', () => {
  it('formats an issued testnet asset as CODE:ISSUER', () => {
    expect(usdcEscrowTerms().asset).toBe(`USDC:${USDC_ISSUER}`);
  });

  it('formats the native asset as XLM', () => {
    const terms = buildEscrowTerms({ assetCode: 'XLM', amount: '1', claimant: BENEFICIARY });
    expect(terms.asset).toBe('XLM');
  });

  it('normalizes the amount to Stellar 7-decimal precision', () => {
    expect(usdcEscrowTerms().amount).toBe('10.0000000');
    expect(usdcEscrowTerms({ amount: '10.5' }).amount).toBe('10.5000000');
  });

  it('refuses an issued asset without an issuer', () => {
    expect(() => buildEscrowTerms({ assetCode: 'USDC', amount: '10', claimant: BENEFICIARY })).toThrow(
      BalanceMismatchError
    );
  });

  it('refuses a non-numeric amount', () => {
    expect(() => usdcEscrowTerms({ amount: 'ten' })).toThrow(BalanceMismatchError);
  });

  it('refuses a claimant that is not a Stellar account id', () => {
    expect(() => usdcEscrowTerms({ claimant: BENEFICIARY.slice(1) })).toThrow(BalanceMismatchError);
  });
});

describe('canonicalAssetString', () => {
  it('maps Horizon native markers to XLM', () => {
    expect(canonicalAssetString('native')).toBe('XLM');
    expect(canonicalAssetString({ asset_type: 'native' })).toBe('XLM');
  });

  it('maps an issued asset to CODE:ISSUER', () => {
    expect(
      canonicalAssetString({
        asset_type: 'credit_alphanum4',
        asset_code: 'USDC',
        asset_issuer: USDC_ISSUER,
      })
    ).toBe(`USDC:${USDC_ISSUER}`);
  });

  it('refuses an issued asset record without code or issuer', () => {
    expect(() => canonicalAssetString({ asset_type: 'credit_alphanum4' })).toThrow(BalanceMismatchError);
  });
});

describe('normalizeBalanceRecord', () => {
  it('carries the claimed flag through so already-claimed balances can be refused', () => {
    expect(normalizeBalanceRecord(loadFixture('claimed-balance.json')).claimed).toBe(true);
  });

  it('leaves claimed undefined on an unclaimed balance', () => {
    expect(normalizeBalanceRecord(loadFixture('claimable-balance-matching.json')).claimed).toBeUndefined();
  });

  it('refuses a malformed record', () => {
    expect(() => normalizeBalanceRecord({ id: 'x' })).toThrow(BalanceMismatchError);
  });
});

describe('loadAndVerifyBalance against recorded Horizon JSON', () => {
  it('accepts the balance that matches the order escrow', async () => {
    const balance = await loadAndVerifyBalance(
      ORDER_BALANCE_ID,
      usdcEscrowTerms(),
      replayingLoader(loadFixture('claimable-balance-matching.json'))
    );
    expect(balance.id).toBe(ORDER_BALANCE_ID);
    expect(balance.amount).toBe('10.0000000');
  });

  it('rejects a balance with a different amount', async () => {
    const error = await rejection(ORDER_BALANCE_ID, loadFixture('wrong-amount.json'));
    expect(error.code).toBe('amount_mismatch');
  });

  it('rejects a balance with a different asset', async () => {
    const xlmTerms = buildEscrowTerms({ assetCode: 'XLM', amount: '10', claimant: BENEFICIARY });
    const error = await rejection(ORDER_BALANCE_ID, loadFixture('claimable-balance-matching.json'), xlmTerms);
    expect(error.code).toBe('asset_mismatch');
  });

  it('rejects a balance id that belongs to another order', async () => {
    const error = await rejection(FOREIGN_BALANCE_ID, loadFixture('foreign-balance-id.json'));
    expect(error.code).toBe('claimant_mismatch');
  });

  it('rejects a balance that is already claimed', async () => {
    const error = await rejection(ORDER_BALANCE_ID, loadFixture('claimed-balance.json'));
    expect(error.code).toBe('already_claimed');
  });

  it('rejects a balance id Horizon does not know', async () => {
    const error = await rejection(FOREIGN_BALANCE_ID, null);
    expect(error.code).toBe('not_found');
  });

  it('rejects when the Horizon lookup itself fails', async () => {
    const failing: BalanceLoader = {
      async loadBalance() {
        throw new Error('horizon timed out');
      },
    };
    await expect(loadAndVerifyBalance(ORDER_BALANCE_ID, usdcEscrowTerms(), failing)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('never puts the preimage into the refusal message', async () => {
    const error = await rejection(ORDER_BALANCE_ID, loadFixture('wrong-amount.json'));
    expect(error.message).not.toContain(PREIMAGE);
  });
});

describe('verifyBalanceMatchesEscrow', () => {
  it('reports the balance id on every refusal', async () => {
    const error = await rejection(ORDER_BALANCE_ID, loadFixture('wrong-amount.json'));
    expect(error.balanceId).toBe(ORDER_BALANCE_ID);
  });

  it('refuses when the escrow claimant is not one of the balance claimants', () => {
    const balance = normalizeBalanceRecord(loadFixture('claimable-balance-matching.json'));
    const strangerClaimant = usdcEscrowTerms({ claimant: Keypair.random().publicKey() });
    expect(() => verifyBalanceMatchesEscrow(balance, strangerClaimant)).toThrow(BalanceMismatchError);
  });

  it('accepts a balance whose claimant list contains the escrow claimant', () => {
    const balance = normalizeBalanceRecord(loadFixture('claimable-balance-matching.json'));
    expect(() => verifyBalanceMatchesEscrow(balance, usdcEscrowTerms())).not.toThrow();
  });
});
