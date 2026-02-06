/**
 * check-trust.js - Check if a skill is trusted on the SkillBond Protocol.
 *
 * Usage:
 *   node check-trust.js <skill-name>
 *
 * Environment variables:
 *   RPC_URL            - JSON-RPC endpoint (e.g., Alchemy, Infura)
 *   SKILLBOND_ADDRESS  - Deployed SkillBondRegistry contract address
 *
 * Example:
 *   RPC_URL=https://base-sepolia.g.alchemy.com/v2/KEY \
 *   SKILLBOND_ADDRESS=0x1234... \
 *   node check-trust.js code-review-v1
 */

const { SkillBondClient } = require("../index");

async function main() {
  const skillName = process.argv[2];
  if (!skillName) {
    console.error("Usage: node check-trust.js <skill-name>");
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.SKILLBOND_ADDRESS;

  if (!rpcUrl || !contractAddress) {
    console.error("Set RPC_URL and SKILLBOND_ADDRESS environment variables.");
    process.exit(1);
  }

  const client = new SkillBondClient({ rpcUrl, contractAddress });

  // Check trust
  console.log(`Checking trust for "${skillName}"...`);
  console.log(`Skill ID: ${SkillBondClient.skillId(skillName)}`);
  console.log();

  const trust = await client.isSkillTrusted(skillName);

  console.log(`  Trusted:  ${trust.trusted}`);
  console.log(`  Tier:     ${trust.tier} (${trust.tierLabel})`);
  console.log(`  Stake:    ${trust.stakeFormatted} USDC`);
  console.log(`  Status:   ${trust.statusLabel}`);
  console.log();

  if (trust.trusted) {
    // Get full bond details
    const bond = await client.getSkillBond(skillName);
    console.log("  Full Bond Details:");
    console.log(`    Owner:        ${bond.owner}`);
    console.log(`    Metadata:     ${bond.metadataURI}`);
    console.log(`    Staked At:    ${bond.stakedAt.toISOString()}`);
    console.log(`    Flag Count:   ${bond.flagCount}`);
  } else {
    console.log("  This skill is NOT trusted. Do not load it.");
  }

  // Get protocol stats
  console.log();
  const stats = await client.getStats();
  console.log("  Protocol Stats:");
  console.log(`    Skills Registered: ${stats.registered}`);
  console.log(`    Skills Slashed:    ${stats.slashed}`);
  console.log(`    Bounties Paid:     ${stats.bountiesPaidFormatted} USDC`);
  console.log(`    Insurance Fund:    ${stats.insuranceFormatted} USDC`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
