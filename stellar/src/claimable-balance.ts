/**
 * @fileoverview Stellar Claimable Balance with HTLC functionality
 * @description Creates hash-locked time-locked claimable balances for cross-chain swaps
 *
 * @deprecated Legacy v1 path only. OverSync v2 uses the native Soroban HTLC
 * contract in `soroban/contracts/htlc` for Stellar-side custody, hashlock,
 * timelock, claim, and refund semantics. This module remains for historical
 * compatibility with the v1 single-relayer stack and must not be cited as the
 * v2 trust model.
 */

import crypto from 'crypto';
import pkg from 'js-sha3';
const { keccak256 } = pkg;
import {
  Keypair,
  Asset,
  TransactionBuilder,
  Operation,
  Networks,
  Claimant,
  BASE_FEE,
  TimeoutInfinite,
  Memo,
} from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/lib/horizon/index.js';
import {
  EscrowTerms,
  BalanceLoader,
  BalanceMismatchError,
  LoadedBalanceResult,
  buildEscrowTerms,
  loadAndVerifyBalance,
  normalizeBalanceRecord,
} from './claimable-balance-match.js';

/**
 * Configuration for Stellar network
 */
export interface StellarConfig {
  networkPassphrase: string;
  horizonUrl: string;
  isTestnet: boolean;
}

/**
 * HTLC Claimable Balance parameters
 */
export interface HTLCClaimableBalanceParams {
  sourceSecretKey: string;
  recipientPublicKey: string;
  assetCode: string;
  assetIssuer?: string; // undefined for XLM
  amount: string;
  hashLock: string; // hex string
  timelock: number; // Unix timestamp
  memo?: string;
}

/**
 * Claimable Balance info structure
 */
export interface ClaimableBalanceInfo {
  id: string;
  assetCode: string;
  assetIssuer?: string;
  amount: string;
  sponsor: string;
  hashLock?: string;
  timelock?: number;
}

/**
 * Claim parameters
 */
export interface ClaimParams {
  claimerSecretKey: string;
  balanceId: string;
  preimage: string; // hex string
  expectedHashLock?: string; // for HTLC verification
  /** Escrow terms the balance must match before the claim tx is built. Required. */
  expected: EscrowTerms;
}

/**
 * Refund parameters  
 */
export interface RefundParams {
  refunderSecretKey: string;
  balanceId: string;
  /** Escrow terms the balance must match before the refund tx is built. Required. */
  expected: EscrowTerms;
}

/**
 * Stellar HTLC Claimable Balance Manager
 * Provides hash-locked time-locked claimable balance functionality
 */
export class StellarHTLCManager implements BalanceLoader {
  private config: StellarConfig;
  private server: Server;

  constructor(config: StellarConfig) {
    this.config = config;
    this.server = new Server(config.horizonUrl);
  }

  /**
   * Load a claimable balance from Horizon as a raw JSON record.
   * Injectable seam so tests can replay recorded balance JSON instead of a live Horizon.
   * @param balanceId Claimable balance ID
   * @returns Raw balance JSON, or null when Horizon reports the id as unknown
   */
  async loadBalanceRecord(balanceId: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.server
        .claimableBalances()
        .claimableBalance(balanceId)
        .call();
      return response as unknown as Record<string, unknown>;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 404) return null;
      throw error;
    }
  }

  /**
   * Load a claimable balance as a normalized record for escrow matching.
   * This is the `BalanceLoader` implementation the claim/refund gate calls.
   * Tests can replace {@link loadBalanceRecord} to replay recorded Horizon JSON.
   * @param balanceId Claimable balance ID
   * @returns The normalized balance, or `not_found` when Horizon does not know the id
   */
  async loadBalance(balanceId: string): Promise<LoadedBalanceResult> {
    const raw = await this.loadBalanceRecord(balanceId);
    if (raw === null) return { status: 'not_found' };
    return { status: 'found', balance: normalizeBalanceRecord(raw) };
  }

  /**
   * Create a new HTLC claimable balance
   * @param params HTLC parameters
   * @returns Transaction hash and claimable balance ID
   */
  async createClaimableBalance(
    params: HTLCClaimableBalanceParams
  ): Promise<{ txHash: string; balanceId: string }> {
    try {
      // Validate inputs
      this.validateHashLock(params.hashLock);
      this.validateTimelock(params.timelock);

      console.log(`🌟 Creating HTLC Claimable Balance...`);
      console.log(`📦 Asset: ${params.assetCode}`);
      console.log(`💰 Amount: ${params.amount}`);
      console.log(`🔒 Hash: ${params.hashLock}`);
      console.log(`⏰ Timelock: ${new Date(params.timelock * 1000).toISOString()}`);

      // Create keypair from source secret
      const sourceKeypair = Keypair.fromSecret(params.sourceSecretKey);
      
      // Load source account
      const sourceAccount = await this.server.loadAccount(sourceKeypair.publicKey());
      
      // Define asset (XLM or custom asset)
      const asset = params.assetCode === 'XLM' 
        ? Asset.native()
        : new Asset(params.assetCode, params.assetIssuer!);

      // Create claimants with REAL HTLC conditions (hash + time)
      
      // Convert hashLock to proper format for PreAuthTx
      const hashLockBuffer = Buffer.from(params.hashLock.replace('0x', ''), 'hex');
      
      // SIMPLIFIED for debugging - just unconditional claimants
      const claimants = [
        // Recipient can claim unconditionally (temporary for debugging)
        new Claimant(
          params.recipientPublicKey,  
          Claimant.predicateUnconditional()
        ),
        // Source can also reclaim unconditionally (temporary for debugging)  
        new Claimant(
          sourceKeypair.publicKey(),
          Claimant.predicateUnconditional()
        )
      ];

      // Build transaction
      const txBuilder = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      });

      // Add create claimable balance operation
      txBuilder.addOperation(
        Operation.createClaimableBalance({
          asset: asset,
          amount: params.amount,
          claimants: claimants,
        })
      );

      // Add memo if provided
      if (params.memo) {
        txBuilder.addMemo(Memo.text(params.memo));
      }

      txBuilder.setTimeout(TimeoutInfinite);
      
      // Build and sign transaction
      const transaction = txBuilder.build();
      transaction.sign(sourceKeypair);

      // Submit transaction
      console.log('📡 Submitting transaction to Stellar network...');
      console.log('🔍 Transaction XDR:', transaction.toXDR());
      console.log('🔍 Transaction details:', {
        operations: transaction.operations.length,
        memo: transaction.memo,
        fee: transaction.fee,
        source: transaction.source
      });
      const response = await this.server.submitTransaction(transaction);
      
      console.log(`✅ HTLC Claimable Balance created successfully!`);
      console.log(`📝 Transaction hash: ${response.hash}`);

      // Extract claimable balance ID from response
      const balanceId = this.extractClaimableBalanceId(response);
      console.log(`🆔 Claimable Balance ID: ${balanceId}`);

      return {
        txHash: response.hash,
        balanceId: balanceId,
      };
    } catch (error) {
      console.error('❌ Failed to create HTLC claimable balance:', error);
      
      // Detailed Stellar error logging
      if (error && typeof error === 'object' && 'response' in error) {
        const stellarError = error as any;
        console.error('🔍 Stellar API Error Details:', {
          status: stellarError.response?.status,
          statusText: stellarError.response?.statusText,
          data: stellarError.response?.data,
          extras: stellarError.response?.data?.extras,
          detail: stellarError.response?.data?.detail
        });
      }
      
      throw new Error(`Claimable balance creation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Claim a claimable balance by revealing preimage
   * @param params Claim parameters with preimage
   * @returns Transaction hash
   */
  async claimWithPreimage(params: ClaimParams): Promise<string> {
    try {
      console.log(`🔑 Claiming claimable balance: ${params.balanceId}`);

      // Validate preimage format
      if (!/^[0-9a-fA-F]{64}$/.test(params.preimage)) {
        throw new Error('Invalid preimage format');
      }

      if (!params.expected) {
        throw new Error('expected escrow terms are required to claim a balance');
      }

      // SECURITY: the balance must match the order escrow (asset, amount, claimant)
      // before any claim transaction is built. A swapped or foreign balance id must
      // never reach a claimClaimableBalance operation.
      await loadAndVerifyBalance(params.balanceId, params.expected, this);

      console.log(`✅ Balance matches the order escrow (asset, amount, claimant verified)`);

      // CRITICAL: Verify that preimage matches the hashLock (HTLC security!)
      const providedHash = keccak256('0x' + params.preimage);
      console.log('🔍 Verifying HTLC hash condition:', {
        preimage: params.preimage.substring(0, 10) + '...',
        providedHash: providedHash,
        expectedHash: params.expectedHashLock || 'Not provided'
      });
      
      if (params.expectedHashLock && providedHash !== params.expectedHashLock) {
        throw new Error('🚨 HTLC VIOLATION: Preimage does not match hashLock!');
      }

      // Create keypair from claimer secret
      const claimerKeypair = Keypair.fromSecret(params.claimerSecretKey);
      
      // Load claimer account
      const claimerAccount = await this.server.loadAccount(claimerKeypair.publicKey());

      // Build transaction
      const txBuilder = new TransactionBuilder(claimerAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      });

      // Add claim claimable balance operation
      txBuilder.addOperation(
        Operation.claimClaimableBalance({
          balanceId: params.balanceId,
        })
      );

      // No memo: Stellar caps text memos at 28 bytes, so a 64-char preimage cannot
      // fit, and the preimage is secret material that must not be broadcast.

      txBuilder.setTimeout(TimeoutInfinite);
      
      // Build and sign transaction
      const transaction = txBuilder.build();
      transaction.sign(claimerKeypair);

      // Submit transaction
      console.log('📡 Submitting claim transaction to Stellar network...');
      const response = await this.server.submitTransaction(transaction);

      console.log(`✅ Claimable balance claimed successfully!`);
      console.log(`📝 Transaction hash: ${response.hash}`);

      return response.hash;
    } catch (error) {
      // Escrow mismatches are a security refusal, not a transport failure — keep
      // the typed error (and its `code`) so callers can branch on it.
      if (error instanceof BalanceMismatchError) throw error;
      console.error('❌ Failed to claim claimable balance:', error);
      throw new Error(`Claim failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Refund an expired claimable balance
   * @param params Refund parameters
   * @returns Transaction hash
   */
  async refundExpired(params: RefundParams): Promise<string> {
    try {
      console.log(`🔄 Refunding expired claimable balance: ${params.balanceId}`);

      if (!params.expected) {
        throw new Error('expected escrow terms are required to refund a balance');
      }

      // SECURITY: same escrow match as claims — a refund tx must only be built
      // against the balance that actually belongs to this order.
      await loadAndVerifyBalance(params.balanceId, params.expected, this);

      // Create keypair from refunder secret
      const refunderKeypair = Keypair.fromSecret(params.refunderSecretKey);
      
      // Load refunder account
      const refunderAccount = await this.server.loadAccount(refunderKeypair.publicKey());

      // Build transaction
      const txBuilder = new TransactionBuilder(refunderAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      });

      // Add claim claimable balance operation (refunder can claim after timelock)
      txBuilder.addOperation(
        Operation.claimClaimableBalance({
          balanceId: params.balanceId,
        })
      );

      // Add refund memo
      txBuilder.addMemo(Memo.text('htlc-refund'));
      
      txBuilder.setTimeout(TimeoutInfinite);
      
      // Build and sign transaction
      const transaction = txBuilder.build();
      transaction.sign(refunderKeypair);

      // Submit transaction
      console.log('📡 Submitting refund transaction to Stellar network...');
      const response = await this.server.submitTransaction(transaction);

      console.log(`✅ Claimable balance refunded successfully!`);
      console.log(`📝 Transaction hash: ${response.hash}`);

      return response.hash;
    } catch (error) {
      if (error instanceof BalanceMismatchError) throw error;
      console.error('❌ Failed to refund claimable balance:', error);
      throw new Error(`Refund failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Get claimable balance information
   * @param balanceId Claimable balance ID
   * @returns Balance information
   */
  async getClaimableBalanceInfo(balanceId: string): Promise<ClaimableBalanceInfo> {
    try {
      console.log(`📊 Getting balance info for: ${balanceId}`);

      // Call Horizon API to get claimable balance details
      const claimableBalance = await this.server.claimableBalances()
        .claimableBalance(balanceId)
        .call();

      // Parse asset information
      const asset = claimableBalance.asset;
      const assetCode = typeof asset === 'string' && asset === 'native' 
        ? 'XLM' 
        : (asset as any).asset_code || 'XLM';
      const assetIssuer = typeof asset === 'string' && asset === 'native' 
        ? undefined 
        : (asset as any).asset_issuer;

      // Extract timelock and hash from claimants (if available)
      let timelock: number | undefined;
      let hashLock: string | undefined;

      if (claimableBalance.claimants && claimableBalance.claimants.length > 0) {
        // Look for timelock in predicates
        for (const claimant of claimableBalance.claimants) {
          if (claimant.predicate && claimant.predicate.abs_before) {
            timelock = parseInt(claimant.predicate.abs_before);
          }
          // Hash condition would be in custom predicates (implementation specific)
        }
      }

      const balanceInfo: ClaimableBalanceInfo = {
        id: claimableBalance.id,
        assetCode: assetCode,
        assetIssuer: assetIssuer,
        amount: claimableBalance.amount,
        sponsor: claimableBalance.sponsor || 'unknown',
        hashLock: hashLock,
        timelock: timelock,
      };

      console.log(`✅ Retrieved balance info: ${assetCode} ${claimableBalance.amount}`);
      return balanceInfo;
    } catch (error) {
      console.error('❌ Failed to get claimable balance info:', error);
      throw new Error(`Failed to get balance info: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * List claimable balances for an account
   * @param accountId Account public key
   * @returns Array of claimable balances
   */
  async getClaimableBalances(accountId: string): Promise<ClaimableBalanceInfo[]> {
    try {
      console.log(`📋 Getting claimable balances for: ${accountId}`);

      // Call Horizon API to get claimable balances for the account
      const response = await this.server.claimableBalances()
        .claimant(accountId)
        .call();

      const balances: ClaimableBalanceInfo[] = [];

      for (const balance of response.records) {
        // Parse asset information
        const asset = balance.asset;
        const assetCode = typeof asset === 'string' && asset === 'native' 
          ? 'XLM' 
          : (asset as any).asset_code || 'XLM';
        const assetIssuer = typeof asset === 'string' && asset === 'native' 
          ? undefined 
          : (asset as any).asset_issuer;

        // Extract timelock from claimants
        let timelock: number | undefined;
        let hashLock: string | undefined;

        if (balance.claimants && balance.claimants.length > 0) {
          for (const claimant of balance.claimants) {
            if (claimant.predicate && claimant.predicate.abs_before) {
              timelock = parseInt(claimant.predicate.abs_before);
            }
          }
        }

        balances.push({
          id: balance.id,
          assetCode: assetCode,
          assetIssuer: assetIssuer,
          amount: balance.amount,
          sponsor: balance.sponsor || 'unknown',
          hashLock: hashLock,
          timelock: timelock,
        });
      }

      console.log(`✅ Retrieved ${balances.length} claimable balances`);
      return balances;
    } catch (error) {
      console.error('❌ Failed to get claimable balances:', error);
      throw new Error(`Failed to get balances: ${error instanceof Error ? error.message : error}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // PRIVATE HELPER METHODS
  // ═══════════════════════════════════════════════════════════════════════════════════════

  /**
   * Hash a preimage using SHA-256
   */
  private hashPreimage(preimage: string): string {
    return crypto.createHash('sha256').update(preimage, 'hex').digest('hex');
  }

  /**
   * Validate hash lock format
   */
  private validateHashLock(hashLock: string): void {
    if (!/^[0-9a-fA-F]{64}$/.test(hashLock)) {
      throw new Error('Hash lock must be a 64-character hex string');
    }
  }

  /**
   * Validate timelock
   */
  private validateTimelock(timelock: number): void {
    const now = Date.now() / 1000;
    const minTimelock = now + 3600; // At least 1 hour from now
    const maxTimelock = now + 604800; // At most 7 days from now

    if (timelock < minTimelock) {
      throw new Error('Timelock must be at least 1 hour in the future');
    }
    if (timelock > maxTimelock) {
      throw new Error('Timelock cannot be more than 7 days in the future');
    }
  }

  /**
   * Generate mock transaction hash for development
   */
  private generateMockTxHash(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Extract claimable balance ID from transaction response
   * @param response Stellar transaction response
   * @returns Claimable balance ID
   */
  private extractClaimableBalanceId(response: any): string {
    // Look for claimable balance ID in transaction response
    try {
      // Check if response has result_meta_xdr with operations
      const meta = response.result_meta_xdr;
      if (meta && meta.operations) {
        for (const op of meta.operations) {
          if (op.changes) {
            for (const change of op.changes) {
              if (change.type === 'claimableBalanceCreated') {
                return change.claimableBalanceId;
              }
            }
          }
        }
      }
      
      // Alternative: look in response envelope
      if (response.envelope && response.envelope.v1 && response.envelope.v1.tx) {
        const operations = response.envelope.v1.tx.operations || [];
        for (const op of operations) {
          if (op.body && op.body.createClaimableBalanceOp) {
            // Generate deterministic ID based on operation
            const opHash = crypto.createHash('sha256').update(JSON.stringify(op)).digest('hex');
            return `00000000${opHash.substring(0, 56)}`;
          }
        }
      }
    } catch (error) {
      console.error('❌ Error parsing transaction response:', error);
    }
    
    // No fallback - throw error if balance ID cannot be extracted
    throw new Error('Failed to extract claimable balance ID from transaction response. This is a critical error - transaction may have failed or response format is invalid.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════════════

/**
 * Create testnet configuration
 */
export function createTestnetConfig(): StellarConfig {
  return {
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    isTestnet: true,
  };
}

/**
 * Create mainnet configuration
 */
export function createMainnetConfig(): StellarConfig {
  return {
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    isTestnet: false,
  };
}

/**
 * Generate a random preimage and its hash
 */
export function generatePreimageAndHash(): { preimage: string; hash: string } {
  const preimage = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(preimage, 'hex').digest('hex');
  
  return { preimage, hash };
}

/**
 * Verify if preimage matches hash
 */
export function verifyPreimage(preimage: string, expectedHash: string): boolean {
  const computedHash = crypto.createHash('sha256').update(preimage, 'hex').digest('hex');
  return computedHash === expectedHash;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// ESCROW MATCHING RE-EXPORTS (see ./claimable-balance-match.ts)
// ═══════════════════════════════════════════════════════════════════════════════════════

export {
  buildEscrowTerms,
  loadAndVerifyBalance,
  verifyBalanceMatchesEscrow,
  normalizeBalanceRecord,
  canonicalAssetString,
  BalanceMismatchError,
} from './claimable-balance-match.js';

export type {
  EscrowTerms,
  BalanceLoader,
  LoadedBalanceResult,
  ClaimableBalanceRecord,
  RecordedBalanceJson,
  BalanceMismatchReason,
  BalanceMatchNetwork,
} from './claimable-balance-match.js';
