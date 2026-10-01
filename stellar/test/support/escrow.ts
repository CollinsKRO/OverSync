/**
 * @fileoverview Shared escrow constants for claimable-balance tests.
 * @description The recorded fixtures under test/fixtures all describe the same
 * USDC escrow; these constants are the order side of that escrow.
 */

import { buildEscrowTerms } from '../../src/claimable-balance.js';
import type { EscrowTerms } from '../../src/claimable-balance-match.js';
import type { CrossChainOrder } from '../../src/stellar-client.js';

/** Stellar account the recorded balances are claimable by (order beneficiary). */
export const BENEFICIARY = 'GAV7T7MVACC6EI5WKABDDTD3T4EICILDOIX3GAQ5QXA7YOYL5KQSWLBR';
/** A second account present on some recorded balances (the order's other claimant). */
export const OTHER_CLAIMANT = 'GAM5UF5YSDBDIMJFIFWL5L5JRSTD3RDOMST2OHARXSCXTN6LR46ZISZ6';
/** USDC issuer used by every recorded fixture. */
export const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
/** Ethereum address that resolves to USDC on testnet via @oversync/sdk. */
export const USDC_ETH_TOKEN = '0xa0b86a33e6417c4fd30ad9d05d6b9b7cd6dd11b';

/** Balance id of the escrow that belongs to the order under test. */
export const ORDER_BALANCE_ID =
  '00000000a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
/** Balance id belonging to a different order. */
export const FOREIGN_BALANCE_ID =
  '00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

/** 32-byte secret, hex encoded — never written into an error string. */
export const PREIMAGE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** The escrow terms the recorded USDC balance must match. */
export function usdcEscrowTerms(overrides: Partial<Parameters<typeof buildEscrowTerms>[0]> = {}): EscrowTerms {
  return buildEscrowTerms({
    assetCode: 'USDC',
    assetIssuer: USDC_ISSUER,
    amount: '10',
    claimant: BENEFICIARY,
    ...overrides,
  });
}

/** A cross-chain order whose Stellar side is the recorded USDC escrow. */
export function usdcOrder(overrides: Partial<CrossChainOrder> = {}): CrossChainOrder {
  return {
    ethereumOrderId: 1,
    ethereumTxHash: `0x${'ab'.repeat(32)}`,
    token: USDC_ETH_TOKEN,
    amount: '10',
    hashLock: `0x${'cd'.repeat(32)}`,
    timelock: 1_900_000_000,
    sender: `0x${'11'.repeat(20)}`,
    recipient: BENEFICIARY,
    ...overrides,
  };
}
