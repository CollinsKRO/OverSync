import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import escrowArtifact from "./fixtures/escrow-artifact.json";
import registryArtifact from "./fixtures/registry-artifact.json";
import committedHashes from "../../v2-bytecode-hashes.json";
import {
  artifactHashes,
  checkBytecodeHashes,
  checkMainnetAddresses,
  predictedAddresses,
} from "../../scripts/v2/deploy-guard";

describe("v2 deployment preflight", () => {
  const actual = artifactHashes({ HTLCEscrow: escrowArtifact, ResolverRegistry: registryArtifact });

  it("matches the committed hashes to the compiled contract artifacts", async () => {
    const compiled = artifactHashes({
      HTLCEscrow: await artifacts.readArtifact("HTLCEscrow"),
      ResolverRegistry: await artifacts.readArtifact("ResolverRegistry"),
    });
    expect(() => checkBytecodeHashes(compiled, committedHashes)).not.to.throw();
  });

  it("rejects either fixture bytecode mismatch before a deploy can start", () => {
    for (const name of ["HTLCEscrow", "ResolverRegistry"] as const) {
      expect(() => checkBytecodeHashes(actual, { ...actual, [name]: ethers.ZeroHash }))
        .to.throw(`${name} bytecode hash mismatch`);
    }
  });

  it("accepts matching fixture artifacts and predicted addresses", () => {
    expect(() => checkBytecodeHashes(actual, actual)).not.to.throw();
    const predicted = predictedAddresses("0x0000000000000000000000000000000000000001", 0);
    expect(() => checkMainnetAddresses(predicted, predicted)).not.to.throw();
  });

  it("rejects a missing or stale address before broadcast", () => {
    const predicted = predictedAddresses("0x0000000000000000000000000000000000000001", 0);
    expect(() => checkMainnetAddresses({ ResolverRegistry: predicted.ResolverRegistry }, predicted))
      .to.throw("HTLCEscrow address is missing");
    expect(() => checkMainnetAddresses({ ...predicted, HTLCEscrow: ethers.ZeroAddress }, predicted))
      .to.throw("HTLCEscrow address is missing");
    expect(() => checkMainnetAddresses({ ...predicted, HTLCEscrow: "0x0000000000000000000000000000000000000002" }, predicted))
      .to.throw("HTLCEscrow address mismatch");
  });
});
