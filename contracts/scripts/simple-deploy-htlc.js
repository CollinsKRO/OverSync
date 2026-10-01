const { ethers } = require("hardhat");

async function main() {
  const registryAddress = process.env.RESOLVER_REGISTRY_ADDRESS;
  if (!registryAddress || !ethers.isAddress(registryAddress) || registryAddress === ethers.ZeroAddress) {
    throw new Error("Set RESOLVER_REGISTRY_ADDRESS to the deployed resolver registry");
  }
  console.log("🚀 Simple MainnetHTLC Deploy...");

  // Get deployer
  const [deployer] = await ethers.getSigners();
  console.log("👤 Deploying with:", deployer.address);
  
  // Get balance
  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("💰 Balance:", ethers.formatEther(balance), "ETH");
  
  if (balance === 0n) {
    console.error("❌ No ETH balance!");
    process.exit(1);
  }

  try {
    // Get contract factory
    const MainnetHTLC = await ethers.getContractFactory("MainnetHTLC");
    
    console.log("📦 Deploying contract...");
    
    // Deploy with simple options
    const contract = await MainnetHTLC.deploy(registryAddress);
    
    console.log("⏳ Waiting for deployment...");
    await contract.waitForDeployment();
    
    const address = await contract.getAddress();
    
    console.log("✅ MainnetHTLC deployed successfully!");
    console.log("📍 Contract Address:", address);
    console.log("🔗 Etherscan:", `https://etherscan.io/address/${address}`);
    
    // Update relayer config
    console.log("\n🔧 Update your relayer config:");
    console.log(`   htlcBridge: '${address}' // Add to mainnet config`);
    
  } catch (error) {
    console.error("❌ Deploy failed:", error.message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
