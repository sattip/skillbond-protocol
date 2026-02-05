const hre = require("hardhat");

async function main() {
  const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS;
  if (!REGISTRY_ADDRESS) {
    console.error("Set REGISTRY_ADDRESS env var first");
    process.exit(1);
  }

  const USDC_ADDRESS = process.env.USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const [admin] = await hre.ethers.getSigners();

  console.log("=== SkillBond Protocol Demo ===\n");
  console.log("Admin (Court):", admin.address);

  const registry = await hre.ethers.getContractAt("SkillBondRegistry", REGISTRY_ADDRESS);
  const usdc = await hre.ethers.getContractAt(
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    USDC_ADDRESS
  );

  const skillId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("malicious-skill-v1.0"));
  console.log("\nSkill ID:", skillId);

  console.log("\n--- Scene 1: Skill Stakes 100 USDC ---");
  const stakeAmount = 100n * 10n ** 6n;

  const approveTx = await usdc.approve(REGISTRY_ADDRESS, stakeAmount);
  await approveTx.wait();
  console.log("Approved USDC spend. TX:", approveTx.hash);

  const stakeTx = await registry.stakeSkill(skillId, "ipfs://QmFakeHash_malicious_skill", stakeAmount);
  await stakeTx.wait();
  console.log("Skill staked! TX:", stakeTx.hash);

  const [trusted, stake] = await registry.isSkillTrusted(skillId);
  console.log(`Skill trusted: ${trusted}, Stake: ${Number(stake) / 1e6} USDC`);

  console.log("\n--- Scene 2: THE SLASH ---");
  const slashTx = await registry.executeSlash(skillId, admin.address);
  await slashTx.wait();
  console.log("SLASHED! TX:", slashTx.hash);

  const [trustedAfter] = await registry.isSkillTrusted(skillId);
  const stats = await registry.getStats();
  console.log(`\nSkill trusted after slash: ${trustedAfter}`);
  console.log(`\n=== Protocol Stats ===`);
  console.log(`Skills Registered: ${stats[0]}`);
  console.log(`Skills Slashed: ${stats[1]}`);
  console.log(`Total Bounties Paid: ${Number(stats[2]) / 1e6} USDC`);
  console.log(`Insurance Fund: ${Number(stats[3]) / 1e6} USDC`);
  console.log("\n=== The hunter got paid. The skill is dead. ===");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
