import { describe, it, expect, vi } from "vitest";
import {
  createRelayConfirmer,
  stageEthereumTransaction,
  stageStellarTransaction,
} from "../src/relay-submission-port.js";
import type { RelayConfirmationRef } from "../src/relay-submission-tracker.js";

/**
 * Chain adapters are tested against hand-rolled fakes. The real
 * `@stellar/stellar-sdk` and `ethers` are used only for the *local* hash
 * computation, which is a pure function of the signed payload — no network.
 */

function ref(over: Partial<RelayConfirmationRef> = {}): RelayConfirmationRef {
  return {
    key: 'xlm_to_eth:claim:order_1#abcd1234',
    orderKey: 'order_1|xlm_to_eth#abcd1234',
    txHash: 'a'.repeat(64),
    chain: 'ethereum',
    network: 'sepolia',
    orderId: 'order_1',
    side: 'xlm_to_eth',
    action: 'claim',
    attempt: 1,
    maxAttempts: 3,
    ...over,
  };
}

describe("stageStellarTransaction", () => {
  it("derives the hash locally and only then submits", async () => {
    const hash = 'b'.repeat(32);
    const submitTransaction = vi.fn(async () => ({ hash }));
    const transaction = { hash: () => Buffer.from(hash, 'hex') };

    const staged = stageStellarTransaction({
      server: { submitTransaction } as never,
      transaction,
      network: 'testnet',
    });

    // The hash is available before anything touches the network.
    expect(staged.txHash).toBe(hash);
    expect(staged.network).toBe('testnet');
    expect(submitTransaction).not.toHaveBeenCalled();

    await expect(staged.broadcast()).resolves.toEqual({ hash });
    expect(submitTransaction).toHaveBeenCalledTimes(1);
    expect(submitTransaction).toHaveBeenCalledWith(transaction);
  });

  it("refuses to stage a transaction whose hash cannot be computed", () => {
    expect(() =>
      stageStellarTransaction({
        server: { submitTransaction: vi.fn() } as never,
        transaction: { hash: () => Buffer.alloc(0) },
        network: 'testnet',
      })
    ).toThrow(/hash could not be computed/i);
  });

  it("produces the same hash as the Stellar SDK for a real signed envelope", async () => {
    // Proves the locally derived hash is the one Horizon will report, which is
    // what makes "record the hash before broadcast" sound.
    const { Keypair, Networks, TransactionBuilder, Account, Operation, Asset, Memo, BASE_FEE } =
      await import('@stellar/stellar-sdk');
    const keypair = Keypair.random();
    const account = new Account(keypair.publicKey(), '1');
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: keypair.publicKey(), asset: Asset.native(), amount: '1.5' })
      )
      .addMemo(Memo.text('hash-first'))
      .setTimeout(300)
      .build();
    tx.sign(keypair);

    // The signature base digest is what Stellar defines as the transaction hash,
    // and it is independent of the signatures.
    const beforeSigning = tx.hash().toString('hex');

    const staged = stageStellarTransaction({
      server: { submitTransaction: vi.fn() } as never,
      transaction: tx,
      network: 'testnet',
    });

    expect(staged.txHash).toBe(beforeSigning);
    expect(staged.txHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("stageEthereumTransaction", () => {
  it("signs locally, persists the local hash, then broadcasts the same payload", async () => {
    const signTransaction = vi.fn(async () => '0x' + 'ab'.repeat(40) + '');
    const sent = { wait: vi.fn(async () => ({ hash: '0x' + 'ab'.repeat(40) + '', status: 1 })) };
    const broadcastTransaction = vi.fn(async () => sent);

    const staged = await stageEthereumTransaction({
      wallet: { signTransaction } as never,
      provider: { broadcastTransaction } as never,
      request: { to: '0x1', value: '1' },
      network: 'sepolia',
    });

    // keccak256 of the signed payload — the hash the node will report.
    expect(staged.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).not.toHaveBeenCalled();

    const receipt = await staged.broadcast();
    expect(receipt).toEqual({ hash: '0x' + 'ab'.repeat(40) + '', status: 1 });
    // Exactly one broadcast of exactly the payload we signed.
    expect(broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).toHaveBeenCalledWith('0x' + 'ab'.repeat(40) + '');
  });

  it("retries a rate-limited broadcast with the identical payload", async () => {
    const rawTx = '0x' + 'cd'.repeat(40);
    const signTransaction = vi.fn(async () => rawTx);
    const wait = vi.fn(async () => ({ hash: 'h' }));
    const broadcastTransaction = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('exceeded compute units'), { code: 429 }))
      .mockRejectedValueOnce(Object.assign(new Error('rate limit'), { code: 429 }))
      .mockResolvedValue({ wait });
    const sleep = vi.fn(async () => {});

    const staged = await stageEthereumTransaction({
      wallet: { signTransaction } as never,
      provider: { broadcastTransaction } as never,
      request: {},
      network: 'sepolia',
      sleep,
    });
    const hashBeforeBroadcast = staged.txHash;

    await staged.broadcast();

    // Signed once, so every retry carries the same hash: no second transaction.
    expect(signTransaction).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).toHaveBeenCalledTimes(3);
    expect(broadcastTransaction.mock.calls.every(([payload]) => payload === rawTx)).toBe(true);
    expect(hashBeforeBroadcast).toBe(staged.txHash);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-rate-limit failure", async () => {
    const broadcastTransaction = vi.fn(async () => {
      throw Object.assign(new Error('insufficient funds'), { code: 'ACTION_REJECTED' });
    });

    const staged = await stageEthereumTransaction({
      wallet: { signTransaction: async () => '0x' + 'cd'.repeat(40) } as never,
      provider: { broadcastTransaction } as never,
      request: {},
      network: 'sepolia',
      sleep: async () => {},
    });

    await expect(staged.broadcast()).rejects.toThrow(/insufficient funds/);
    expect(broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it("gives up after the broadcast retry budget", async () => {
    const broadcastTransaction = vi.fn(async () => {
      throw Object.assign(new Error('rate limit'), { code: 429 });
    });
    const staged = await stageEthereumTransaction({
      wallet: { signTransaction: async () => '0x' + 'cd'.repeat(40) } as never,
      provider: { broadcastTransaction } as never,
      request: {},
      network: 'sepolia',
      maxBroadcastRetries: 2,
      sleep: async () => {},
    });

    await expect(staged.broadcast()).rejects.toThrow(/rate limit/);
    expect(broadcastTransaction).toHaveBeenCalledTimes(3);
  });
});

describe("createRelayConfirmer", () => {
  const noDeps = {
    getStellarServer: async () => ({}) as never,
    getEthereumProvider: async () => ({}) as never,
  };

  it("reports a Stellar transaction that Horizon knows as succeeded", async () => {
    const confirm = createRelayConfirmer({
      ...noDeps,
      getStellarServer: async () =>
        ({ transactions: () => ({ transaction: () => ({ call: async () => ({ successful: true, hash: 'x' }) }) }) }) as never,
    });
    await expect(confirm(ref({ chain: 'stellar' }))).resolves.toMatchObject({ state: 'succeeded' });
  });

  it("reports a Stellar transaction that landed but failed as failed", async () => {
    const confirm = createRelayConfirmer({
      ...noDeps,
      getStellarServer: async () =>
        ({
          transactions: () => ({
            transaction: () => ({ call: async () => ({ successful: false, result_codes: { transaction: 'tx_failed' } }) }),
          }),
        }) as never,
    });
    const result = await confirm(ref({ chain: 'stellar' }));
    expect(result.state).toBe('failed');
    expect(result.error).toMatch(/failed on ledger/i);
  });

  it("maps a Horizon 404 to not_found rather than to a failure", async () => {
    const confirm = createRelayConfirmer({
      ...noDeps,
      getStellarServer: async () =>
        ({
          transactions: () => ({
            transaction: () => ({
              call: async () => {
                throw Object.assign(new Error('not found'), { response: { status: 404 } });
              },
            }),
          }),
        }) as never,
    });
    await expect(confirm(ref({ chain: 'stellar' }))).resolves.toEqual({ state: 'not_found' });
  });

  it("treats a Horizon outage as pending, not as evidence", async () => {
    const confirm = createRelayConfirmer({
      ...noDeps,
      getStellarServer: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const result = await confirm(ref({ chain: 'stellar' }));
    expect(result.state).toBe('pending');
    expect(result.error).toMatch(/horizon unavailable/);
  });

  it("maps an Ethereum receipt to succeeded or failed", async () => {
    const succeeded = createRelayConfirmer({
      ...noDeps,
      getEthereumProvider: async () => ({ getTransactionReceipt: async () => ({ status: 1 }) }) as never,
    });
    await expect(succeeded(ref())).resolves.toMatchObject({ state: 'succeeded' });

    const reverted = createRelayConfirmer({
      ...noDeps,
      getEthereumProvider: async () => ({ getTransactionReceipt: async () => ({ status: 0 }) }) as never,
    });
    const result = await reverted(ref());
    expect(result.state).toBe('failed');
    expect(result.error).toMatch(/reverted/i);
  });

  it("distinguishes an Ethereum tx that is known-but-unmined from one no node has seen", async () => {
    const pendingConfirmer = createRelayConfirmer({
      ...noDeps,
      getEthereumProvider: async () =>
        ({ getTransactionReceipt: async () => null, getTransaction: async () => ({ hash: 'a' }) }) as never,
    });
    await expect(pendingConfirmer(ref())).resolves.toEqual({ state: 'pending' });

    const unknownConfirmer = createRelayConfirmer({
      ...noDeps,
      getEthereumProvider: async () =>
        ({ getTransactionReceipt: async () => null, getTransaction: async () => null }) as never,
    });
    await expect(unknownConfirmer(ref())).resolves.toEqual({ state: 'not_found' });
  });

  it("never throws, so a flaky node can never be read as a dead transaction", async () => {
    const confirm = createRelayConfirmer({
      ...noDeps,
      getEthereumProvider: async () =>
        ({
          getTransactionReceipt: async () => {
            throw new Error('502 Bad Gateway');
          },
        }) as never,
    });
    const result = await confirm(ref());
    expect(result.state).toBe('pending');
    expect(result.error).toMatch(/502/);
  });

  it("refuses to guess for an unknown chain and stays pending", async () => {
    const confirm = createRelayConfirmer(noDeps);
    const result = await confirm(ref({ chain: 'solana' }));
    expect(result.state).toBe('pending');
    expect(result.error).toMatch(/no confirmer configured/i);
  });
});
