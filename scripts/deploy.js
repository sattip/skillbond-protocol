const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying SkillBondRegistry with account:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "ETH");

  // USDC on Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
  const USDC_ADDRESS = process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  console.log("Using USDC at:", USDC_ADDRESS);

  const SkillBondRegistry = await hre.ethers.getContractFactory("SkillBondRegistry");
  const registry = await SkillBondRegistry.deploy(USDC_ADDRESS);
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log("\n========================================");
  console.log("SkillBondRegistry deployed to:", address);
  console.log("========================================");
  console.log("\nVerify with:");
  console.log(`npx hardhat verify --network baseSepolia ${address} ${USDC_ADDRESS}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
