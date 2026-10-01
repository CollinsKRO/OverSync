const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('HTLCBridge Legacy Lock Rejection', function () {
  let HTLCBridge, htlcBridge, owner, user;
  let mockV2EscrowAddress = '0x' + '1'.repeat(40);

  beforeEach(async () => {
    [owner, user] = await ethers.getSigners();
    HTLCBridge = await ethers.getContractFactory('HTLCBridge');
    htlcBridge = await HTLCBridge.deploy(owner.address);
  });

  it('should revert legacy lock when v2 escrow is active', async function () {
    await htlcBridge.connect(owner).setActiveV2Escrow(mockV2EscrowAddress);

    const lockHash = ethers.utils.formatBytes32String('test');
    const amount = ethers.utils.parseEther('1');

    await expect(
      htlcBridge.connect(user).newLock(lockHash, owner.address, amount, 1000, { value: amount })
    ).to.be.revertedWith('Legacy lock rejected: v2 escrow active');
  });

  it('should allow legacy lock when no v2 escrow is set', async function () {
    const lockHash = ethers.utils.formatBytes32String('test');
    const amount = ethers.utils.parseEther('1');

    await expect(
      htlcBridge.connect(user).newLock(lockHash, owner.address, amount, 1000, { value: amount })
    ).to.not.be.reverted;

    expect(await htlcBridge.locked(lockHash)).to.be.true;
  });
});
