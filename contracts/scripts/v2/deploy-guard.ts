import { ethers } from "hardhat";

const { getAddress, getCreateAddress, isAddress, keccak256, ZeroAddress } = ethers;

export const contractNames = ["HTLCEscrow", "ResolverRegistry"] as const;
export type ContractName = typeof contractNames[number];
export type Hashes = Record<ContractName, string>;
export type Addresses = Record<ContractName, string>;

export function artifactHashes(artifacts: Record<ContractName, { bytecode: string }>): Hashes {
  return {
    HTLCEscrow: keccak256(artifacts.HTLCEscrow.bytecode),
    ResolverRegistry: keccak256(artifacts.ResolverRegistry.bytecode),
  };
}

export function checkBytecodeHashes(actual: Hashes, expected: Partial<Hashes>): void {
  for (const name of contractNames) {
    if (!expected[name] || actual[name].toLowerCase() !== expected[name]?.toLowerCase()) {
      throw new Error(`${name} bytecode hash mismatch: expected ${expected[name] ?? "missing"}, got ${actual[name]}`);
    }
  }
}

export function predictedAddresses(deployer: string, nonce: number): Addresses {
  return {
    ResolverRegistry: getCreateAddress({ from: deployer, nonce }),
    HTLCEscrow: getCreateAddress({ from: deployer, nonce: nonce + 1 }),
  };
}

export function checkMainnetAddresses(configured: Partial<Addresses> | undefined, predicted: Addresses): void {
  for (const name of contractNames) {
    const address = configured?.[name];
    if (!address || !isAddress(address) || getAddress(address) === ZeroAddress) {
      throw new Error(`${name} address is missing or invalid in deployments.mainnet.json`);
    }
    if (getAddress(address) !== predicted[name]) {
      throw new Error(`${name} address mismatch: manifest has ${address}, next deployment would use ${predicted[name]}`);
    }
  }
}
