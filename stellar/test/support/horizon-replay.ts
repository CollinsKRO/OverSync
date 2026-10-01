/**
 * @fileoverview Recorded-Horizon replay harness for claimable-balance tests.
 * @description Replaces the two live-Horizon touch points on StellarHTLCManager —
 * the balance lookup (`loadBalanceRecord`) and the submit/account endpoints — so
 * tests replay recorded claimable-balance JSON instead of calling a real Horizon.
 * Any call the stub does not implement throws, which keeps the "no live Horizon"
 * rule enforced rather than assumed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, Transaction } from '@stellar/stellar-sdk';
import { StellarHTLCManager } from '../../src/claimable-balance.js';
import type { RecordedBalanceJson } from '../../src/claimable-balance-match.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Read a recorded Horizon claimable-balance fixture by file name. */
export function loadFixture(name: string): RecordedBalanceJson {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8')) as RecordedBalanceJson;
}

/** Handle on the replayed Horizon, so tests can assert what was (not) built. */
export interface ReplayHorizon {
  /** Register the recorded balance a balance id resolves to; `null` makes it unknown. */
  setBalance(balanceId: string, record: RecordedBalanceJson | null): void;
  /** Transactions the code under test actually submitted — i.e. claims/refunds it built. */
  readonly submitted: Transaction[];
  /** Number of times an account was loaded; a refused claim must never reach this. */
  readonly accountLoads: number;
}

/**
 * Swap a manager's Horizon for an in-memory replay of recorded balance JSON.
 * @param manager Manager whose claim/refund paths are under test
 */
export function installReplayHorizon(manager: StellarHTLCManager): ReplayHorizon {
  const records = new Map<string, RecordedBalanceJson>();
  const submitted: Transaction[] = [];
  const counters = { accountLoads: 0 };

  const server = {
    loadAccount: async (accountId: string) => {
      counters.accountLoads += 1;
      return new Account(accountId, '4711');
    },
    submitTransaction: async (transaction: Transaction) => {
      submitted.push(transaction);
      return { hash: `replayed-tx-${submitted.length}` };
    },
    claimableBalances: () => {
      throw new Error('live Horizon claimable-balance lookup attempted in tests');
    },
  };

  (manager as unknown as { server: unknown }).server = server;
  manager.loadBalanceRecord = async (balanceId) => records.get(balanceId) ?? null;

  return {
    setBalance(balanceId, record) {
      if (record === null) records.delete(balanceId);
      else records.set(balanceId, record);
    },
    get submitted() {
      return submitted;
    },
    get accountLoads() {
      return counters.accountLoads;
    },
  };
}
