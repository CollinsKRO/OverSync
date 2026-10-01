import { describe, expect, it, vi } from "vitest";
import { buildFaucetPayment, walletIsConfiguredTestnet } from "./TestnetFaucet";

describe("testnet faucet", () => {
  it("builds the fixture payment on testnet", () => {
    const build = vi.fn(() => ({ amount: "1" }));
    expect(walletIsConfiguredTestnet("testnet")).toBe(true);
    expect(buildFaucetPayment("testnet", build)).toEqual({ amount: "1" });
    expect(build).toHaveBeenCalledOnce();
  });

  it("does not build on mainnet", () => {
    const build = vi.fn(() => ({ amount: "1" }));
    expect(buildFaucetPayment("mainnet", build)).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it("does not build when the network changes before submit", () => {
    let network: string = "testnet";
    const build = vi.fn(() => ({ amount: "1" }));
    network = "mainnet";
    expect(buildFaucetPayment(network, build)).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });
});
