import { afterEach, describe, expect, it, vi } from "vitest";

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../src/logger.js", () => ({ getLogger: () => ({ info }) }));

import { loadConfig } from "../src/config.js";

describe("resolver configuration logging", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    info.mockClear();
  });

  it("logs address mappings without exposing resolver credentials or RPC URL secrets", () => {
    const escrow = "0x1111111111111111111111111111111111111111";
    const registry = "0x2222222222222222222222222222222222222222";
    const ethKey = `0x${"a".repeat(64)}`;
    const stellarSecret = `S${"A".repeat(55)}`;
    const rpcSecret = "rpc-path-secret";

    vi.stubEnv("NETWORK_MODE", "testnet");
    vi.stubEnv("ETH_HTLC_ESCROW_TESTNET", escrow);
    vi.stubEnv("ETH_RESOLVER_REGISTRY_TESTNET", registry);
    vi.stubEnv("RESOLVER_ETH_PRIVATE_KEY", ethKey);
    vi.stubEnv("RESOLVER_STELLAR_SECRET", stellarSecret);
    vi.stubEnv("SEPOLIA_RPC_URL", `https://example.test/${rpcSecret}`);
    vi.stubEnv("SOROBAN_RPC_URL", `https://soroban.example.test/${rpcSecret}`);

    const config = loadConfig();
    expect(config.ethereum.resolverPrivateKey).toBe(ethKey);
    expect(config.soroban.resolverSecret).toBe(stellarSecret);

    const output = JSON.stringify(info.mock.calls);
    expect(output).toContain(escrow);
    expect(output).toContain(registry);
    expect(output).not.toContain(ethKey);
    expect(output).not.toContain(stellarSecret);
    expect(output).not.toContain(rpcSecret);
  });
});
