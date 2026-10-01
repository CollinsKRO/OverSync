/**
 * @fileoverview Stellar blockchain operations for FusionBridge
 * @description Handles Stellar network interactions, claimable balances, and HTLC operations
 */

// Main exports
export { default as StellarClient, default } from './stellar-client.js';
export { StellarHTLCManager } from './claimable-balance.js';
export { EnhancedStellarBridge } from './enhanced-stellar-bridge.js';

// Types and interfaces
export type {
  StellarConfig,
  HTLCClaimableBalanceParams,
  ClaimableBalanceInfo,
  ClaimParams,
  RefundParams,
} from './claimable-balance';

export type {
  EnhancedBridgeConfig,
  CrossChainOrderParams,
  BridgeOrderState,
} from './enhanced-stellar-bridge.js';

export { BridgeOrderStatus } from './enhanced-stellar-bridge.js';

export type {
  CrossChainOrder,
  StellarBridgeResult,
} from './stellar-client.js';

// Utility functions
export {
  createTestnetConfig,
  createMainnetConfig,
  generatePreimageAndHash,
  verifyPreimage,
  buildEscrowTerms,
  loadAndVerifyBalance,
} from './claimable-balance.js';

export type {
  EscrowTerms,
  ClaimableBalanceRecord,
  RecordedBalanceJson,
  BalanceLoader,
  LoadedBalanceResult,
  BalanceMismatchError,
  BalanceMismatchReason,
} from './claimable-balance-match.js';

// Configuration constants
export const STELLAR_CONFIG = {
  testnet: {
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    isTestnet: true,
  },
  mainnet: {
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    isTestnet: false,
  },
};

console.log('🌟 Stellar workspace initialized for FusionBridge'); 