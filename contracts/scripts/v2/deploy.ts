import { artifacts, ethers, network } from "hardhat";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  artifactHashes,
  checkBytecodeHashes,
  checkMainnetAddresses,
  predictedAddresses,
  type Addresses,
} from "./deploy-guard";

/**
 * Deploy v2 contracts after checking compiled creation bytecode against the
 * committed hashes. Set V2_DRY_RUN=true to print the decision without sending.
 * Mainnet also requires both predicted addresses in deployments.mainnet.json.
 */
async function main() {
  const dryRun = process.env.V2_DRY_RUN === "true";
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("A deployer signer is required");

  const stakeAsset = process.env.V2_STAKE_ASSET;
  if (!stakeAsset || !ethers.isAddress(stakeAsset) || stakeAsset === ethers.ZeroAddress) {
    throw new Error("V2_STAKE_ASSET must be a nonzero ERC20 address");
  }
  const minStake = BigInt(process.env.V2_MIN_STAKE ?? "0");
  const minSafetyDeposit = BigInt(process.env.V2_MIN_SAFETY_DEPOSIT ?? "0");

  const expectedPath = path.resolve(__dirname, "../../v2-bytecode-hashes.json");
  const outPath = path.resolve(__dirname, `../../../deployments.${network.name}.json`);
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const actual = artifactHashes({
    HTLCEscrow: await artifacts.readArtifact("HTLCEscrow"),
    ResolverRegistry: await artifacts.readArtifact("ResolverRegistry"),
  });
  checkBytecodeHashes(actual, expected);

  // A missing or malformed mainnet manifest fails closed before any transaction.
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  let expectedAddresses: Addresses | undefined;
  if (network.name === "mainnet") {
    if (chainId !== 1) throw new Error(`mainnet must use chain ID 1 (got ${chainId})`);
    const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
    expectedAddresses = predictedAddresses(deployer.address, nonce);
    console.log(`Next mainnet addresses: ResolverRegistry ${expectedAddresses.ResolverRegistry}, HTLCEscrow ${expectedAddresses.HTLCEscrow}`);
    checkMainnetAddresses(existing.ethereum?.contracts, expectedAddresses);
  }

  console.log(`Network: ${network.name}; deployer: ${deployer.address}`);
  console.log(`HTLCEscrow bytecode hash: ${actual.HTLCEscrow}`);
  console.log(`ResolverRegistry bytecode hash: ${actual.ResolverRegistry}`);
  console.log("Preflight: hashes match and mainnet addresses are present when required.");
  if (dryRun) {
    console.log("Dry-run decision: PASS; no transactions sent or manifest written.");
    return;
  }

  const Registry = await ethers.getContractFactory("ResolverRegistry");
  const registry = await Registry.deploy(stakeAsset, minStake, deployer.address, deployer.address);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  if (expectedAddresses && registryAddress !== expectedAddresses.ResolverRegistry) {
    throw new Error(`ResolverRegistry deployed at ${registryAddress}, expected ${expectedAddresses.ResolverRegistry}`);
  }
  console.log(`ResolverRegistry @ ${registryAddress}`);

  const Escrow = await ethers.getContractFactory("HTLCEscrow");
  const escrow = await Escrow.deploy(registryAddress, minSafetyDeposit);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  if (expectedAddresses && escrowAddress !== expectedAddresses.HTLCEscrow) {
    throw new Error(`HTLCEscrow deployed at ${escrowAddress}, expected ${expectedAddresses.HTLCEscrow}`);
  }
  console.log(`HTLCEscrow @ ${escrowAddress}`);

  const out = {
    ...existing,
    network: network.name,
    chainId,
    deployer: deployer.address,
    ethereum: {
      ...existing.ethereum,
      htlcEscrow: escrowAddress,
      resolverRegistry: registryAddress,
      contracts: { ...existing.ethereum?.contracts, HTLCEscrow: escrowAddress, ResolverRegistry: registryAddress },
      bytecodeHashes: actual,
    },
    config: {
      stakeAsset,
      minStake: minStake.toString(),
      minSafetyDeposit: minSafetyDeposit.toString(),
    },
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Deployment summary written to ${outPath}`);
}

main().catch((err) => {
  if (process.env.V2_DRY_RUN === "true") console.error("Dry-run decision: FAIL");
  console.error(err instanceof Error ? err.message : "Deployment failed");
  process.exitCode = 1;
});
