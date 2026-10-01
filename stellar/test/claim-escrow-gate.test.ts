/**
 * @fileoverview The escrow gate must run before any claim or refund tx is built (issue #267).
 * @description Claim/refund attempts are driven against a replayed Horizon so a refusal
 * can be asserted as "built nothing": no account load, no transaction, no submit.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import pkg from 'js-sha3';
import {
  BalanceMismatchError,
  StellarHTLCManager,
  createTestnetConfig,
} from '../src/claimable-balance.js';
import StellarClient from '../src/stellar-client.js';
import type { CrossChainOrder } from '../src/stellar-client.js';
import { installReplayHorizon, loadFixture } from './support/horizon-replay.js';
import {
  FOREIGN_BALANCE_ID,
  ORDER_BALANCE_ID,
  PREIMAGE,
  usdcEscrowTerms,
  usdcOrder,
} from './support/escrow.js';

const { keccak256 } = pkg;
const HASHLOCK = keccak256(`0x${PREIMAGE}`);

let manager: StellarHTLCManager;
let horizon: ReturnType<typeof installReplayHorizon>;
let claimer: Keypair;

/** Operation types of every transaction the code under test actually built. */
function builtOperationTypes(): string[] {
  return horizon.submitted.flatMap((tx) => tx.operations.map((op) => op.type));
}

function claimParams(balanceId: string, expected = usdcEscrowTerms()) {
  return {
    claimerSecretKey: claimer.secret(),
    balanceId,
    preimage: PREIMAGE,
    expectedHashLock: HASHLOCK,
    expected,
  };
}

beforeEach(() => {
  manager = new StellarHTLCManager(createTestnetConfig());
  horizon = installReplayHorizon(manager);
  claimer = Keypair.random();
  horizon.setBalance(ORDER_BALANCE_ID, loadFixture('claimable-balance-matching.json'));
  horizon.setBalance(FOREIGN_BALANCE_ID, loadFixture('foreign-balance-id.json'));
});

describe('claimWithPreimage', () => {
  it('builds exactly one claim for the balance that matches the order escrow', async () => {
    const txHash = await manager.claimWithPreimage(claimParams(ORDER_BALANCE_ID));

    expect(txHash).toBe('replayed-tx-1');
    expect(builtOperationTypes()).toEqual(['claimClaimableBalance']);
    expect(horizon.accountLoads).toBe(1);
  });

  it('never puts the preimage into the claim transaction', async () => {
    await manager.claimWithPreimage(claimParams(ORDER_BALANCE_ID));

    const [transaction] = horizon.submitted;
    expect(transaction.memo.type).toBe('none')
    // Memo is a 'none' type, so no text field set (undefined is acceptable)
  });

  it('builds nothing when the amount differs from the order escrow', async () => {
    horizon.setBalance(ORDER_BALANCE_ID, loadFixture('wrong-amount.json'));

    await expect(manager.claimWithPreimage(claimParams(ORDER_BALANCE_ID))).rejects.toMatchObject({
      name: 'BalanceMismatchError',
      code: 'amount_mismatch',
    });
    expect(horizon.submitted).toHaveLength(0);
    expect(horizon.accountLoads).toBe(0);
  });

  it('builds nothing when the asset differs from the order escrow', async () => {
    const xlmTerms = usdcEscrowTerms({ assetCode: 'XLM', amount: '10' });

    await expect(manager.claimWithPreimage(claimParams(ORDER_BALANCE_ID, xlmTerms))).rejects.toMatchObject({
      name: 'BalanceMismatchError',
      code: 'asset_mismatch',
    });
    expect(horizon.submitted).toHaveLength(0);
    expect(horizon.accountLoads).toBe(0);
  });

  it('builds nothing for a balance id that belongs to another order', async () => {
    await expect(manager.claimWithPreimage(claimParams(FOREIGN_BALANCE_ID))).rejects.toMatchObject({
      name: 'BalanceMismatchError',
      code: 'claimant_mismatch',
    });
    expect(horizon.submitted).toHaveLength(0);
    expect(horizon.accountLoads).toBe(0);
  });

  it('builds nothing for a balance that is already claimed', async () => {
    horizon.setBalance(ORDER_BALANCE_ID, loadFixture('claimed-balance.json'));

    await expect(manager.claimWithPreimage(claimParams(ORDER_BALANCE_ID))).rejects.toMatchObject({
      name: 'BalanceMismatchError',
      code: 'already_claimed',
    });
    expect(horizon.submitted).toHaveLength(0);
    expect(horizon.accountLoads).toBe(0);
  });

  it('builds nothing when the balance id is unknown to the network', async () => {
    horizon.setBalance(FOREIGN_BALANCE_ID, null);

    await expect(manager.claimWithPreimage(claimParams(FOREIGN_BALANCE_ID))).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(horizon.submitted).toHaveLength(0);
    expect(horizon.accountLoads).toBe(0);
  });

  it('keeps the preimage out of every refusal message', async () => {
    horizon.setBalance(ORDER_BALANCE_ID, loadFixture('wrong-amount.json'));

    const mismatch = await manager.claimWithPreimage(claimParams(ORDER_BALANCE_ID)).catch((e: Error) => e);
    expect((mismatch as Error).message).not.toContain(PREIMAGE);

    const badHashlock = await manager
      .claimWithPreimage({ ...claimParams(ORDER_BALANCE_ID), expectedHashLock: `${'00'.repeat(32)}` })
      .catch((e: Error) => e);
    expect((badHashlock as Error).message).not.toContain(PREIMAGE);
  });

  it('refuses a preimage that is not a 32-byte hex secret', async () => {
    await expect(
      manager.claimWithPreimage({ ...claimParams(ORDER_BALANCE_ID), preimage: 'not-a-secret' })
    ).rejects.toThrow('Invalid preimage format');
    expect(horizon.submitted).toHaveLength(0);
  });

  it('requires escrow terms instead of claiming whatever id it is handed', async () => {
    await expect(
      manager.claimWithPreimage({
        claimerSecretKey: claimer.secret(),
        balanceId: ORDER_BALANCE_ID,
        preimage: PREIMAGE,
        expected: undefined as never,
      })
    ).rejects.toThrow('expected escrow terms are required');
    expect(horizon.submitted).toHaveLength(0);
  });
});

describe('refundExpired', () => {
  it('builds exactly one refund for the balance that matches the order escrow', async () => {
    const txHash = await manager.refundExpired({
      refunderSecretKey: claimer.secret(),
      balanceId: ORDER_BALANCE_ID,
      expected: usdcEscrowTerms(),
    });

    expect(txHash).toBe('replayed-tx-1');
    expect(builtOperationTypes()).toEqual(['claimClaimableBalance']);
  });

  it('builds nothing for a balance that belongs to another order', async () => {
    await expect(
      manager.refundExpired({
        refunderSecretKey: claimer.secret(),
        balanceId: FOREIGN_BALANCE_ID,
        expected: usdcEscrowTerms(),
      })
    ).rejects.toBeInstanceOf(BalanceMismatchError);
    expect(horizon.submitted).toHaveLength(0);
    expect(horizon.accountLoads).toBe(0);
  });

  it('builds nothing when the amount differs from the order escrow', async () => {
    horizon.setBalance(ORDER_BALANCE_ID, loadFixture('wrong-amount.json'));

    await expect(
      manager.refundExpired({
        refunderSecretKey: claimer.secret(),
        balanceId: ORDER_BALANCE_ID,
        expected: usdcEscrowTerms(),
      })
    ).rejects.toMatchObject({ code: 'amount_mismatch' });
    expect(horizon.submitted).toHaveLength(0);
  });
});

describe('StellarClient claim/refund wiring', () => {
  let client: StellarClient;
  let clientHorizon: ReturnType<typeof installReplayHorizon>;
  let order: CrossChainOrder;

  beforeEach(() => {
    client = new StellarClient(true, Keypair.random().secret());
    clientHorizon = installReplayHorizon(
      (client as unknown as { htlcManager: StellarHTLCManager }).htlcManager
    );
    clientHorizon.setBalance(ORDER_BALANCE_ID, loadFixture('claimable-balance-matching.json'));
    clientHorizon.setBalance(FOREIGN_BALANCE_ID, loadFixture('foreign-balance-id.json'));
    order = usdcOrder();
  });

  it('claims when the balance matches the order escrow', async () => {
    const result = await client.claimStellarHTLC(ORDER_BALANCE_ID, PREIMAGE, order);

    expect(result).toEqual({ success: true, txHash: 'replayed-tx-1' });
    expect(clientHorizon.submitted).toHaveLength(1);
  });

  it('claims nothing when the order amount differs from the balance', async () => {
    const result = await client.claimStellarHTLC(ORDER_BALANCE_ID, PREIMAGE, usdcOrder({ amount: '99' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('amount_mismatch');
    expect(clientHorizon.submitted).toHaveLength(0);
  });

  it('claims nothing for a balance id that belongs to another order', async () => {
    const result = await client.claimStellarHTLC(FOREIGN_BALANCE_ID, PREIMAGE, order);

    expect(result.success).toBe(false);
    expect(result.error).toContain('claimant_mismatch');
    expect(clientHorizon.submitted).toHaveLength(0);
    expect(result.error).not.toContain(PREIMAGE);
  });

  it('refunds when the balance matches the order escrow', async () => {
    const result = await client.refundStellarHTLC(ORDER_BALANCE_ID, order);

    expect(result.success).toBe(true);
    expect(clientHorizon.submitted).toHaveLength(1);
  });

  it('refunds nothing for a balance id that belongs to another order', async () => {
    const result = await client.refundStellarHTLC(FOREIGN_BALANCE_ID, order);

    expect(result.success).toBe(false);
    expect(clientHorizon.submitted).toHaveLength(0);
  });
});
