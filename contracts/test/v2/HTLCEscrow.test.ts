import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { HTLCEscrow, TestERC20 } from "../../typechain-types";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const TIMELOCK = 600; // 10 minutes
const SAFETY_DEPOSIT = ethers.parseEther("0.001");
const AMOUNT = ethers.parseEther("0.5");

async function deployEscrow() {
  const HTLCEscrow = await ethers.getContractFactory("HTLCEscrow");
  // resolverRegistry = address(0) → permissionless createOrder
  return (await HTLCEscrow.deploy(ZERO_ADDR, 0)) as unknown as HTLCEscrow;
}

async function deployToken() {
  const Token = await ethers.getContractFactory("TestERC20");
  return (await Token.deploy("MockToken", "MOCK", ethers.parseEther("1000000"))) as unknown as TestERC20;
}

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32));
}

describe("HTLCEscrow v2", () => {
  describe("createOrder", () => {
    it("locks native ETH with correct hashlock/timelock", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();

      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      const tx = await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );
      const receipt = await tx.wait();
      const orderCreated = receipt!.logs.find(
        (l: any) => l.fragment?.name === "OrderCreated"
      ) as any;
      expect(orderCreated).to.not.be.undefined;
      const orderId = orderCreated.args.orderId;
      expect(orderId).to.equal(1n);

      const order = await escrow.getOrder(orderId);
      expect(order.amount).to.equal(AMOUNT);
      expect(order.safetyDeposit).to.equal(SAFETY_DEPOSIT);
      expect(order.beneficiary).to.equal(beneficiary.address);
      expect(order.status).to.equal(0); // Funded
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(
        AMOUNT + SAFETY_DEPOSIT
      );
    });

    it("rejects zero amount", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          0,
          SAFETY_DEPOSIT,
          randomBytes32(),
          TIMELOCK,
          { value: SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
    });

    it("rejects zero hashlock", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          ethers.ZeroHash,
          TIMELOCK,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidHashlock");
    });

    it("rejects timelock below MIN_TIMELOCK and above MAX_TIMELOCK", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const hashlock = ethers.sha256(randomBytes32());

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          299,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidTimelock");

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          24 * 60 * 60 + 1,
          { value: AMOUNT + SAFETY_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidTimelock");
    });

    it("rejects msg.value mismatch for native orders", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const hashlock = ethers.sha256(randomBytes32());

      await expect(
        escrow.connect(sender).createOrder(
          beneficiary.address,
          sender.address,
          ZERO_ADDR,
          AMOUNT,
          SAFETY_DEPOSIT,
          hashlock,
          TIMELOCK,
          { value: AMOUNT } // missing safety deposit
        )
      ).to.be.revertedWithCustomError(escrow, "InvalidValue");
    });

    it("locks ERC20 with correct allowance", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const token = await deployToken();

      await token.connect(sender).approve(await escrow.getAddress(), AMOUNT);
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        await token.getAddress(),
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: SAFETY_DEPOSIT }
      );

      expect(await token.balanceOf(await escrow.getAddress())).to.equal(AMOUNT);
    });
  });

  describe("claimOrder", () => {
    it("pays beneficiary on correct sha256 preimage and pays caller the safety deposit", async () => {
      const [sender, beneficiary, relayer] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      const beneficiaryBefore = await ethers.provider.getBalance(beneficiary.address);
      const relayerBefore = await ethers.provider.getBalance(relayer.address);

      const tx = await escrow.connect(relayer).claimOrder(1, preimage);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice!;

      const beneficiaryAfter = await ethers.provider.getBalance(beneficiary.address);
      const relayerAfter = await ethers.provider.getBalance(relayer.address);
      expect(beneficiaryAfter - beneficiaryBefore).to.equal(AMOUNT);
      expect(relayerAfter - relayerBefore + gas).to.equal(SAFETY_DEPOSIT);

      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(1); // Claimed
    });

    it("also accepts a keccak256 hashlock (EVM convention)", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.keccak256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      await expect(escrow.connect(beneficiary).claimOrder(1, preimage)).to.not.be.reverted;
    });

    it("rejects invalid preimage", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      const wrong = randomBytes32();
      await expect(
        escrow.connect(beneficiary).claimOrder(1, wrong)
      ).to.be.revertedWithCustomError(escrow, "InvalidPreimage");
    });

    it("rejects claim after expiry", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      await time.increase(TIMELOCK + 1);

      await expect(
        escrow.connect(beneficiary).claimOrder(1, preimage)
      ).to.be.revertedWithCustomError(escrow, "Expired");
    });

    it("rejects double claim", async () => {
      const [sender, beneficiary] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      await escrow.connect(beneficiary).claimOrder(1, preimage);
      await expect(
        escrow.connect(beneficiary).claimOrder(1, preimage)
      ).to.be.revertedWithCustomError(escrow, "OrderNotClaimable");
    });
  });

  describe("refundOrder", () => {
    it("returns the locked amount to the refund address after timeout, permissionlessly", async () => {
      const [sender, beneficiary, cleaner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);
      const refundAddr = ethers.Wallet.createRandom().address;

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        refundAddr,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      // Refund before expiry → revert
      await expect(
        escrow.connect(cleaner).refundOrder(1)
      ).to.be.revertedWithCustomError(escrow, "NotExpired");

      await time.increase(TIMELOCK + 1);

      const refundBefore = await ethers.provider.getBalance(refundAddr);
      const cleanerBefore = await ethers.provider.getBalance(cleaner.address);

      const tx = await escrow.connect(cleaner).refundOrder(1);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice!;

      expect(await ethers.provider.getBalance(refundAddr)).to.equal(refundBefore + AMOUNT);
      expect(await ethers.provider.getBalance(cleaner.address) + gas).to.equal(
        cleanerBefore + SAFETY_DEPOSIT
      );

      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(2); // Refunded
    });

    it("rejects refund after a successful claim", async () => {
      const [sender, beneficiary, cleaner] = await ethers.getSigners();
      const escrow = await deployEscrow();
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);

      await escrow.connect(sender).createOrder(
        beneficiary.address,
        sender.address,
        ZERO_ADDR,
        AMOUNT,
        SAFETY_DEPOSIT,
        hashlock,
        TIMELOCK,
        { value: AMOUNT + SAFETY_DEPOSIT }
      );

      await escrow.connect(beneficiary).claimOrder(1, preimage);
      await time.increase(TIMELOCK + 1);
      await expect(
        escrow.connect(cleaner).refundOrder(1)
      ).to.be.revertedWithCustomError(escrow, "OrderNotRefundable");
    });
  });

  describe("non-custodial guarantees", () => {
    it("contract has no admin escape hatch", async () => {
      const escrow = await deployEscrow();
      const escrowContract = escrow as any;
      // None of the dangerous admin functions exist on the v2 contract.
      expect(escrowContract.emergencyWithdraw).to.be.undefined;
      expect(escrowContract.pause).to.be.undefined;
      expect(escrowContract.withdraw).to.be.undefined;
      expect(escrowContract.transferOwnership).to.be.undefined;
    });

    it("receive() rejects stray ETH", async () => {
      const [sender] = await ethers.getSigners();
      const escrow = await deployEscrow();
      await expect(
        sender.sendTransaction({ to: await escrow.getAddress(), value: 1n })
      ).to.be.reverted;
    });
  });

  // -----------------------------------------------------------------------
  // Registry-gated claimOrder tests (issue #257)
  // -----------------------------------------------------------------------
  describe("registry-gated claimOrder", () => {
    const MIN_STAKE = ethers.parseEther("100");

    /** Deploy a fully wired registry + escrow pair. */
    async function deployWithRegistry() {
      const [owner, slashBeneficiary, resolver, nonResolver] = await ethers.getSigners();

      // Stake token
      const Token = await ethers.getContractFactory("TestERC20");
      const stakeToken = (await Token.deploy(
        "Stake",
        "STK",
        ethers.parseEther("1000000")
      )) as unknown as TestERC20;

      // Registry
      const Registry = await ethers.getContractFactory("ResolverRegistry");
      const registry = await Registry.deploy(
        await stakeToken.getAddress(),
        MIN_STAKE,
        slashBeneficiary.address,
        owner.address
      );

      // Escrow pointing at the registry — registry gates both create and claim
      const HTLCEscrowFactory = await ethers.getContractFactory("HTLCEscrow");
      const escrow = (await HTLCEscrowFactory.deploy(
        await registry.getAddress(),
        0 // no min safety deposit for simplicity
      )) as unknown as HTLCEscrow;

      // Fund resolver with stake and register
      await stakeToken.transfer(resolver.address, MIN_STAKE * 2n);
      await stakeToken.connect(resolver).approve(await registry.getAddress(), MIN_STAKE);
      await registry.connect(resolver).register(MIN_STAKE);

      return { owner, slashBeneficiary, resolver, nonResolver, stakeToken, registry, escrow };
    }

    /** Create a standard native-ETH order; resolver must be the sender (registry-gated). */
    async function createOrder(escrow: HTLCEscrow, resolver: any, beneficiary: any) {
      const preimage = randomBytes32();
      const hashlock = ethers.sha256(preimage);
      await escrow.connect(resolver).createOrder(
        beneficiary.address,
        resolver.address,
        ZERO_ADDR,
        AMOUNT,
        0n, // no safety deposit
        hashlock,
        TIMELOCK,
        { value: AMOUNT }
      );
      return { preimage, hashlock };
    }

    it("allows a registered resolver to claim a valid order", async () => {
      const { resolver, nonResolver, escrow } = await deployWithRegistry();
      const { preimage } = await createOrder(escrow, resolver, nonResolver);

      await expect(
        escrow.connect(resolver).claimOrder(1, preimage)
      ).to.not.be.reverted;

      const order = await escrow.getOrder(1);
      expect(order.status).to.equal(1); // Claimed
    });

    it("rejects a claim from an address that was never registered", async () => {
      const { resolver, nonResolver, escrow } = await deployWithRegistry();
      const { preimage } = await createOrder(escrow, resolver, nonResolver);

      // nonResolver has never been in the registry
      await expect(
        escrow.connect(nonResolver).claimOrder(1, preimage)
      ).to.be.revertedWithCustomError(escrow, "ClaimResolverNotRegistered");
    });

    it("rejects a claim from a resolver removed after the order was opened", async () => {
      const { resolver, nonResolver, escrow, registry } = await deployWithRegistry();
      const { preimage } = await createOrder(escrow, resolver, nonResolver);

      // Resolver unregisters — order was already created while they were active
      await registry.connect(resolver).unregister();

      // Former resolver cannot claim despite having created the order
      await expect(
        escrow.connect(resolver).claimOrder(1, preimage)
      ).to.be.revertedWithCustomError(escrow, "ClaimResolverNotRegistered");
    });

    it("refundOrder remains permissionless even when registry is set", async () => {
      const [, , , , randomCleaner] = await ethers.getSigners();
      const { resolver, nonResolver, escrow } = await deployWithRegistry();
      await createOrder(escrow, resolver, nonResolver);

      await time.increase(TIMELOCK + 1);

      // Anyone — even an unregistered address — can trigger a refund
      await expect(
        escrow.connect(randomCleaner).refundOrder(1)
      ).to.not.be.reverted;
    });
  });
});
