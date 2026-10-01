import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HTLCEscrow, MainnetHTLC, ResolverRegistry, TestERC20 } from "../../typechain-types";

const AMOUNT = ethers.parseEther("0.1");
const TIMELOCK = 600;
const PREIMAGE = ethers.hexlify(ethers.randomBytes(32));
const WRONG_PREIMAGE = ethers.hexlify(ethers.randomBytes(32));

type ContractKind = "v2" | "mainnet";
type Outcome = "success" | "invalid preimage" | "expired" | "not expired" |
  "not claimable" | "not refundable";

async function fixture() {
  const [owner, resolver, beneficiary, outsider] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("TestERC20"))
    .deploy("Stake", "STK", ethers.parseEther("1000000")) as unknown as TestERC20;
  const registry = await (await ethers.getContractFactory("ResolverRegistry"))
    .deploy(await token.getAddress(), 100n, owner.address, owner.address) as unknown as ResolverRegistry;
  await token.transfer(resolver.address, 100n);
  await token.connect(resolver).approve(await registry.getAddress(), 100n);
  await registry.connect(resolver).register(100n);

  const v2 = await (await ethers.getContractFactory("HTLCEscrow"))
    .deploy(await registry.getAddress(), 0) as unknown as HTLCEscrow;
  const mainnet = await (await ethers.getContractFactory("MainnetHTLC"))
    .deploy(await registry.getAddress()) as unknown as MainnetHTLC;
  return { resolver, beneficiary, outsider, registry, v2, mainnet };
}

async function createOrder(
  kind: ContractKind,
  contracts: Awaited<ReturnType<typeof fixture>>,
  hashlock: string,
  creator = contracts.resolver
) {
  if (kind === "v2") {
    await contracts.v2.connect(creator).createOrder(
      contracts.beneficiary.address, contracts.resolver.address,
      ethers.ZeroAddress, AMOUNT, 0, hashlock, TIMELOCK, { value: AMOUNT }
    );
    return { id: 1n, timelock: Number((await contracts.v2.getOrder(1)).timelock) };
  }

  await contracts.mainnet.connect(creator).createOrder(
    ethers.ZeroAddress, AMOUNT, hashlock, (await time.latest()) + TIMELOCK + 1,
    contracts.beneficiary.address, contracts.resolver.address, { value: AMOUNT }
  );
  const id = await contracts.mainnet.userOrders(creator.address, 0);
  return { id, timelock: Number((await contracts.mainnet.getOrder(id)).timelock) };
}

const rows: Array<{
  name: string;
  action: "claim" | "refund";
  hash: "sha256" | "keccak256";
  preimage?: string;
  secret?: string;
  deactivatedCaller?: boolean;
  prior?: "claim" | "refund";
  moment?: "at expiry" | "after expiry";
  outcome: Outcome;
}> = [
  { name: "unregistered caller claims a sha256 order", action: "claim", hash: "sha256", outcome: "success" },
  { name: "deregistered resolver claims an existing order", action: "claim", hash: "sha256", deactivatedCaller: true, outcome: "success" },
  { name: "unregistered caller claims a keccak256 order", action: "claim", hash: "keccak256", outcome: "success" },
  { name: "short preimage", action: "claim", hash: "sha256", preimage: "0x1234", outcome: "success" },
  { name: "empty preimage", action: "claim", hash: "sha256", preimage: "0x", outcome: "success" },
  { name: "wrong preimage", action: "claim", hash: "sha256", secret: WRONG_PREIMAGE, outcome: "invalid preimage" },
  { name: "claim at expiry", action: "claim", hash: "sha256", moment: "at expiry", outcome: "success" },
  { name: "claim after expiry", action: "claim", hash: "sha256", moment: "after expiry", outcome: "expired" },
  { name: "second claim", action: "claim", hash: "sha256", prior: "claim", outcome: "not claimable" },
  { name: "claim after refund", action: "claim", hash: "sha256", prior: "refund", outcome: "not claimable" },
  { name: "refund before expiry", action: "refund", hash: "sha256", outcome: "not expired" },
  { name: "refund at expiry", action: "refund", hash: "sha256", moment: "at expiry", outcome: "not expired" },
  { name: "refund after expiry", action: "refund", hash: "sha256", moment: "after expiry", outcome: "success" },
  { name: "refund after claim", action: "refund", hash: "sha256", prior: "claim", outcome: "not refundable" },
  { name: "second refund", action: "refund", hash: "sha256", prior: "refund", outcome: "not refundable" },
];

describe("MainnetHTLC and v2 settlement parity", () => {
  for (const [duration, accepted] of [
    [299, false], [300, true], [86400, true], [86401, false],
  ] as const) {
    for (const kind of ["v2", "mainnet"] as const) {
      it(`${kind} ${accepted ? "accepts" : "rejects"} a ${duration}-second timelock`, async () => {
        const contracts = await loadFixture(fixture);
        const hashlock = ethers.sha256(PREIMAGE);
        const attempt = kind === "v2"
          ? contracts.v2.connect(contracts.resolver).createOrder(
              contracts.beneficiary.address, contracts.resolver.address,
              ethers.ZeroAddress, AMOUNT, 0, hashlock, duration, { value: AMOUNT }
            )
          : contracts.mainnet.connect(contracts.resolver).createOrder(
              ethers.ZeroAddress, AMOUNT, hashlock, (await time.latest()) + duration + 1,
              contracts.beneficiary.address, contracts.resolver.address, { value: AMOUNT }
            );
        if (accepted) await expect(attempt).to.not.be.reverted;
        else if (kind === "v2") await expect(attempt).to.be.revertedWithCustomError(contracts.v2, "InvalidTimelock");
        else await expect(attempt).to.be.revertedWith(duration < 300 ? "Timelock too early" : "Timelock too late");
      });
    }
  }

  it("neither contract exposes an owner withdrawal path", async () => {
    const { v2, mainnet } = await loadFixture(fixture);
    for (const contract of [v2, mainnet]) {
      expect(contract.interface.hasFunction("emergencyWithdraw")).to.be.false;
      expect(contract.interface.hasFunction("updateTimelockLimits")).to.be.false;
    }
  });

  for (const row of rows) {
    for (const kind of ["v2", "mainnet"] as const) {
      it(`${row.name}: ${kind} has ${row.outcome} outcome`, async () => {
        const contracts = await loadFixture(fixture);
        const preimage = row.preimage ?? PREIMAGE;
        const hashlock = row.hash === "sha256" ? ethers.sha256(preimage) : ethers.keccak256(preimage);
        const { id, timelock } = await createOrder(kind, contracts, hashlock);
        if (row.deactivatedCaller) await contracts.registry.connect(contracts.resolver).unregister();
        const contract = kind === "v2" ? contracts.v2 : contracts.mainnet;
        const claim = (secret: string) => {
          const caller = row.deactivatedCaller ? contracts.resolver : contracts.outsider;
          if (kind === "v2") return contracts.v2.connect(caller).claimOrder(id as bigint, secret);
          const mainnet = contracts.mainnet.connect(caller);
          return secret.length === 66
            ? mainnet["claimOrder(bytes32,bytes32)"](id as string, secret)
            : mainnet["claimOrder(bytes32,bytes)"](id as string, secret);
        };
        const refund = () => kind === "v2"
          ? contracts.v2.connect(contracts.outsider).refundOrder(id as bigint)
          : contracts.mainnet.connect(contracts.outsider).refundOrder(id as string);

        if (row.prior === "claim") await claim(preimage);
        if (row.prior === "refund") {
          await time.increaseTo(timelock + 1);
          await refund();
        }
        if (row.moment === "at expiry") await time.setNextBlockTimestamp(timelock);
        if (row.moment === "after expiry") await time.increaseTo(timelock + 1);

        const recipient = row.action === "claim" ? contracts.beneficiary.address : contracts.resolver.address;
        const balanceBefore = await ethers.provider.getBalance(recipient);
        const attempt = row.action === "claim" ? claim(row.secret ?? preimage) : refund();
        if (row.outcome === "success") {
          await expect(attempt).to.not.be.reverted;
          const order = kind === "v2"
            ? await contracts.v2.getOrder(id as bigint)
            : await contracts.mainnet.getOrder(id as string);
          expect(order.status).to.equal(row.action === "claim" ? 1n : 2n);
          expect(await ethers.provider.getBalance(recipient)).to.equal(balanceBefore + AMOUNT);
        } else if (kind === "v2") {
          const error = {
            "invalid preimage": "InvalidPreimage", expired: "Expired",
            "not expired": "NotExpired", "not claimable": "OrderNotClaimable",
            "not refundable": "OrderNotRefundable",
          }[row.outcome];
          await expect(attempt).to.be.revertedWithCustomError(contract, error);
        } else {
          const error = {
            "invalid preimage": "Invalid secret", expired: "Order expired",
            "not expired": "Order not expired", "not claimable": "Order not claimable",
            "not refundable": "Order not refundable",
          }[row.outcome];
          await expect(attempt).to.be.revertedWith(error);
        }
      });
    }
  }

  for (const kind of ["v2", "mainnet"] as const) {
    for (const inactive of ["never registered", "unregistered"] as const) {
      it(`${kind} rejects ${inactive === "never registered" ? "a" : "an"} ${inactive} resolver creating an order`, async () => {
        const contracts = await loadFixture(fixture);
        if (inactive === "unregistered") await contracts.registry.connect(contracts.resolver).unregister();
        const creator = inactive === "never registered" ? contracts.outsider : contracts.resolver;
        const hashlock = ethers.sha256(PREIMAGE);
        const attempt = kind === "v2"
          ? contracts.v2.connect(creator).createOrder(
              contracts.beneficiary.address, contracts.resolver.address,
              ethers.ZeroAddress, AMOUNT, 0, hashlock, TIMELOCK, { value: AMOUNT }
            )
          : contracts.mainnet.connect(creator).createOrder(
              ethers.ZeroAddress, AMOUNT, hashlock, (await time.latest()) + TIMELOCK + 1,
              contracts.beneficiary.address, contracts.resolver.address, { value: AMOUNT }
            );
        if (kind === "v2") {
          await expect(attempt).to.be.revertedWithCustomError(contracts.v2, "ResolverNotAuthorised");
        } else {
          await expect(attempt).to.be.revertedWith("Resolver not authorised");
        }
      });
    }
  }
});
