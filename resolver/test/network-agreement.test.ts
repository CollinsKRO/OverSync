import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  compareNetworkAgreement,
  networkPassphraseHash,
  NETWORK_PASSPHRASES,
  checkResolverNetworkAgreement,
  EXPECTED_EVM_CHAIN_ID
} from "../src/network-agreement.js";

// Mock viem
const mockGetChainId = vi.fn();
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getChainId: mockGetChainId
    })),
    http: vi.fn(() => ({}))
  };
});

// Mock @stellar/stellar-sdk
const mockGetLatestLedger = vi.fn();
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        getLatestLedger: mockGetLatestLedger
      }))
    }
  };
});

describe("coordinator/resolver network agreement", () => {
  it("accepts matching Ethereum chain and Stellar passphrase", () => {
    const result = compareNetworkAgreement("testnet", 11_155_111, {
      networkMode: "testnet",
      ethereum: { chainId: 11_155_111 },
      stellar: {
        networkPassphraseHash: networkPassphraseHash(NETWORK_PASSPHRASES.testnet)
      }
    });

    expect(result.status).toBe("ok");
  });

  it("fails when either chain configuration differs", () => {
    const result = compareNetworkAgreement("testnet", 1, {
      networkMode: "mainnet",
      ethereum: { chainId: 1 },
      stellar: {
        networkPassphraseHash: networkPassphraseHash(NETWORK_PASSPHRASES.mainnet)
      }
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Ethereum chain ID differs");
    expect(result.detail).toContain("Stellar network passphrase differs");
    expect(result.detail).not.toContain(NETWORK_PASSPHRASES.mainnet);
  });
});

describe("checkResolverNetworkAgreement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes when both EVM and Soroban RPCs match testnet", async () => {
    mockGetChainId.mockResolvedValue(EXPECTED_EVM_CHAIN_ID.testnet);
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

    const result = await checkResolverNetworkAgreement(
      "testnet",
      "http://localhost:8545",
      "http://localhost:8000",
      NETWORK_PASSPHRASES.testnet
    );

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("EVM chainId=11155111");
    expect(result.detail).toContain("Soroban passphrase matches testnet");
    expect(result.observed.evm.chainId).toBe(11_155_111);
    expect(result.observed.soroban.networkPassphrase).toBe(NETWORK_PASSPHRASES.testnet);
  });

  it("passes when both EVM and Soroban RPCs match mainnet", async () => {
    mockGetChainId.mockResolvedValue(EXPECTED_EVM_CHAIN_ID.mainnet);
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

    const result = await checkResolverNetworkAgreement(
      "mainnet",
      "http://localhost:8545",
      "http://localhost:8000",
      NETWORK_PASSPHRASES.mainnet
    );

    expect(result.status).toBe("ok");
    expect(result.detail).toContain("EVM chainId=1");
    expect(result.detail).toContain("Soroban passphrase matches mainnet");
    expect(result.observed.evm.chainId).toBe(1);
    expect(result.observed.soroban.networkPassphrase).toBe(NETWORK_PASSPHRASES.mainnet);
  });

  it("fails when EVM RPC returns mainnet chainId but NETWORK_MODE is testnet", async () => {
    mockGetChainId.mockResolvedValue(1); // mainnet
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

    const result = await checkResolverNetworkAgreement(
      "testnet",
      "http://localhost:8545",
      "http://localhost:8000",
      NETWORK_PASSPHRASES.testnet
    );

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Ethereum RPC chain ID 1 does not match configured network testnet");
    expect(result.observed.evm.chainId).toBe(1);
  });

  it("fails when Soroban network passphrase is mainnet but NETWORK_MODE is testnet", async () => {
    mockGetChainId.mockResolvedValue(11_155_111);
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

    const result = await checkResolverNetworkAgreement(
      "testnet",
      "http://localhost:8545",
      "http://localhost:8000",
      NETWORK_PASSPHRASES.mainnet // Wrong passphrase for testnet
    );

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Soroban network passphrase");
    expect(result.detail).toContain("does not match configured network testnet");
    expect(result.observed.soroban.networkPassphrase).toBe(NETWORK_PASSPHRASES.mainnet);
  });

  it("fails when EVM and Soroban networks disagree (EVM=mainnet, Soroban=testnet)", async () => {
    mockGetChainId.mockResolvedValue(1); // mainnet
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

    const result = await checkResolverNetworkAgreement(
      "testnet", // configured as testnet
      "http://localhost:8545",
      "http://localhost:8000",
      NETWORK_PASSPHRASES.testnet // Soroban configured as testnet
    );

    // EVM RPC returns mainnet, but Soroban is configured as testnet
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("EVM network (mainnet) and Soroban network (testnet) disagree");
  });

  it("fails when EVM RPC is unreachable", async () => {
    mockGetChainId.mockRejectedValue(new Error("Connection refused"));
    mockGetLatestLedger.mockResolvedValue({ sequence: 1000 });

    const result = await checkResolverNetworkAgreement(
      "testnet",
      "http://user:pass@localhost:8545/path?key=secret",
      "http://localhost:8000",
      NETWORK_PASSPHRASES.testnet
    );

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Ethereum RPC unreachable");
    expect(result.detail).not.toContain("user:pass");
    expect(result.detail).not.toContain("secret");
    expect(result.observed.evm.rpcUrl).toBe("http://localhost:8545");
  });

  it("fails when Soroban RPC is unreachable", async () => {
    mockGetChainId.mockResolvedValue(11_155_111);
    mockGetLatestLedger.mockRejectedValue(new Error("Host unreachable"));

    const result = await checkResolverNetworkAgreement(
      "testnet",
      "http://localhost:8545",
      "http://user:pass@localhost:8000/path?token=secret",
      NETWORK_PASSPHRASES.testnet
    );

    expect(result.status).toBe("fail");
    expect(result.detail).toContain("Soroban RPC unreachable");
    expect(result.detail).not.toContain("user:pass");
    expect(result.detail).not.toContain("secret");
    expect(result.observed.soroban.rpcUrl).toBe("http://localhost:8000");
  });

  it("redacts credentials from error messages", async () => {
    mockGetChainId.mockRejectedValue(new Error("Failed to connect to http://user:pass@evm.example.com/v3/key?token=abc"));
    mockGetLatestLedger.mockRejectedValue(new Error("Failed to connect to https://user:pass@soroban.example.com/rpc/key?auth=xyz"));

    const result = await checkResolverNetworkAgreement(
      "testnet",
      "http://user:pass@evm.example.com/v3/key?token=abc",
      "https://user:pass@soroban.example.com/rpc/key?auth=xyz",
      NETWORK_PASSPHRASES.testnet
    );

    expect(result.status).toBe("fail");
    // Check that credentials are redacted
    for (const secret of ["user", "pass", "key", "abc", "xyz", "token", "auth"]) {
      expect(result.detail).not.toContain(secret);
    }
    expect(result.observed.evm.rpcUrl).toBe("http://evm.example.com");
    expect(result.observed.soroban.rpcUrl).toBe("https://soroban.example.com");
  });
});
