/**
 * policy-enforcement.js - Enforce trust policies before loading AI agent skills.
 *
 * Demonstrates how to use SkillBond as a gatekeeper in your agent framework.
 * Only skills that pass your trust policy are allowed to execute.
 *
 * Usage:
 *   node policy-enforcement.js
 *
 * Environment variables:
 *   RPC_URL            - JSON-RPC endpoint
 *   SKILLBOND_ADDRESS  - Deployed SkillBondRegistry contract address
 */

const { SkillBondClient, TIER_LABELS } = require("../index");

// Simulated skill registry (your agent framework would have this)
const AVAILABLE_SKILLS = [
  "code-review-v1",
  "data-fetch-v2",
  "email-sender-v1",
  "web-scraper-v3",
  "untrusted-skill",
];

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const contractAddress = process.env.SKILLBOND_ADDRESS;

  if (!rpcUrl || !contractAddress) {
    console.error("Set RPC_URL and SKILLBOND_ADDRESS environment variables.");
    process.exit(1);
  }

  const client = new SkillBondClient({ rpcUrl, contractAddress });

  // Define your agent's trust policy
  client.setPolicy({
    minStake: "100",    // Require at least 100 USDC staked
    minTier: 1,         // Require at least BASIC tier
    minAge: 86400,      // Require at least 1 day old (86400 seconds)
  });

  console.log("=== SkillBond Policy Enforcement ===");
  console.log();
  console.log("Policy:");
  console.log("  Min Stake: 100 USDC");
  console.log("  Min Tier:  1 (BASIC)");
  console.log("  Min Age:   1 day");
  console.log();

  // Batch query all skills
  console.log("Checking skills...");
  console.log();

  const results = await client.batchQueryTrust(AVAILABLE_SKILLS);

  const approved = [];
  const rejected = [];

  for (let i = 0; i < AVAILABLE_SKILLS.length; i++) {
    const name = AVAILABLE_SKILLS[i];
    const trust = results[i];

    const { allowed, reasons } = await client.checkPolicy(name);

    if (allowed) {
      approved.push(name);
      console.log(`  [PASS] ${name}`);
      console.log(`         Tier: ${trust.tierLabel} | Stake: ${trust.stakeFormatted} USDC`);
    } else {
      rejected.push({ name, reasons });
      console.log(`  [FAIL] ${name}`);
      reasons.forEach((r) => console.log(`         - ${r}`));
    }
    console.log();
  }

  // Summary
  console.log("=== Summary ===");
  console.log(`  Approved: ${approved.length} skills`);
  console.log(`  Rejected: ${rejected.length} skills`);
  console.log();

  if (approved.length > 0) {
    console.log("  Approved skills (safe to load):");
    approved.forEach((s) => console.log(`    - ${s}`));
  }

  if (rejected.length > 0) {
    console.log();
    console.log("  Rejected skills (DO NOT load):");
    rejected.forEach((r) => {
      console.log(`    - ${r.name}: ${r.reasons[0]}`);
    });
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
