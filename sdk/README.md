# @skillbond/sdk

JavaScript SDK for the **SkillBond Protocol** -- an economic firewall for AI agent skills. Check trust, stake skills, flag malicious behavior, and enforce trust policies.

## Installation

```bash
npm install @skillbond/sdk
```

## Quick Start

Check if a skill is trusted in 3 lines:

```javascript
const { SkillBondClient } = require("@skillbond/sdk");

const client = new SkillBondClient({
  rpcUrl: "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY",
  contractAddress: "0xYOUR_CONTRACT_ADDRESS",
});

const { trusted, tier, stakeFormatted } = await client.isSkillTrusted("code-review-v1");
console.log(trusted, tier, stakeFormatted);
// true 2 "500.00"
```

## API Reference

### Constructor

```javascript
const client = new SkillBondClient({
  rpcUrl: "https://...",           // Required: JSON-RPC endpoint
  contractAddress: "0x...",        // Required: SkillBondRegistry address
  usdcAddress: "0x...",            // Optional: auto-read from contract if omitted
  signer: ethers.Wallet,           // Optional: needed for write operations
});
```

### Read Operations (free, no gas)

#### `isSkillTrusted(skillIdOrName)`

Check if a skill is trusted. Accepts a plain name or bytes32 skillId.

```javascript
const result = await client.isSkillTrusted("my-skill-v1");
// {
//   trusted: true,
//   stake: 500000000n,
//   stakeFormatted: "500.00",
//   tier: 2,
//   tierLabel: "STANDARD",
//   status: 1,
//   statusLabel: "ACTIVE"
// }
```

#### `getTrustTier(skillIdOrName)`

Returns the trust tier as a number (0-3).

| Tier | Label    | Min Stake   | Min Age |
|------|----------|-------------|---------|
| 0    | NONE     | -           | -       |
| 1    | BASIC    | 25 USDC     | 0 days  |
| 2    | STANDARD | 500 USDC    | 30 days |
| 3    | PREMIUM  | 10,000 USDC | 90 days |

#### `getSkillBond(skillIdOrName)`

Returns full bond details: owner, stake, metadataURI, status, stakedAt, flagCount, withdrawalInitiatedAt.

#### `batchQueryTrust(skillIdsOrNames[])`

Query multiple skills in parallel. Returns an array of trust results.

```javascript
const results = await client.batchQueryTrust([
  "code-review-v1",
  "data-fetch-v2",
  "email-sender-v1",
]);
results.forEach(r => console.log(r.tierLabel, r.stakeFormatted));
```

#### `getStats()`

Returns protocol statistics: registered, slashed, bountiesPaid, insurance.

### Write Operations (require signer)

All write operations require a signer. Either pass it in the constructor or call `client.connect(signer)`.

USDC approval is handled automatically -- no need to call `approve()` manually.

#### `stakeSkill(skillIdOrName, metadataURI, amount)`

Register a skill by staking USDC. Amount is in human-readable USDC (e.g., `"100"`).

```javascript
const tx = await client.stakeSkill(
  "my-skill-v1",
  "ipfs://QmSkillManifest...",
  "100"  // 100 USDC
);
await tx.wait();
```

#### `flagSkill(skillIdOrName, evidenceHash)`

Flag a skill as malicious. Requires a 50% counter-stake (auto-approved).

#### `queryTrust(skillIdOrName)`

Paid trust query (0.05 USDC fee). Returns tier, status, stake, and age.

#### `sponsorSkill(skillIdOrName, amount)`

Sponsor a skill by adding USDC to its stake.

#### `initiateWithdrawal(skillIdOrName)`

Start the 7-day withdrawal cooldown.

#### `completeWithdrawal(skillIdOrName)`

Complete withdrawal after cooldown.

#### `cancelWithdrawal(skillIdOrName)`

Cancel withdrawal and return to ACTIVE.

#### `claimFees(skillIdOrName)`

Claim accumulated query fees for a skill you own.

#### `withdrawSponsorship(skillIdOrName)`

Withdraw your sponsorship stake (after cooldown).

### Policy Enforcement

Enforce trust policies locally before loading any skill:

```javascript
client.setPolicy({
  minStake: "100",   // Minimum 100 USDC staked
  minTier: 2,        // Minimum STANDARD tier
  minAge: 604800,    // Minimum 7 days old (in seconds)
});

const { allowed, reasons } = await client.checkPolicy("untrusted-skill");
if (!allowed) {
  console.log("Blocked:", reasons);
  // ["Trust tier 0 (NONE) is below minimum tier 2 (STANDARD)"]
}
```

### Utilities

```javascript
// Compute a skillId from a name
const id = SkillBondClient.skillId("my-skill-v1");
// "0x5f2f..."

// Format/parse USDC amounts
SkillBondClient.formatUSDC(500000000n);  // "500.00"
SkillBondClient.parseUSDC("500");        // 500000000n
```

### Event Listeners

```javascript
client.onSkillStaked((skillId, owner, amount, metadataURI) => {
  console.log(`New skill staked: ${skillId} by ${owner}`);
});

client.onSkillFlagged((skillId, flagger, flagCount, counterStake, evidenceHash) => {
  console.log(`Skill flagged: ${skillId}, flags: ${flagCount}`);
});

client.onSkillSlashed((skillId, whistleblower, bounty, burned) => {
  console.log(`Skill slashed: ${skillId}, bounty: ${bounty}`);
});

// Clean up
client.removeAllListeners();
```

## LangChain / CrewAI Integration

Use the policy engine as a skill gatekeeper in your agent framework:

```javascript
const { SkillBondClient } = require("@skillbond/sdk");

const client = new SkillBondClient({
  rpcUrl: process.env.RPC_URL,
  contractAddress: process.env.SKILLBOND_ADDRESS,
});

client.setPolicy({ minTier: 2, minStake: "100" });

// Use as middleware before loading any tool/skill
async function loadSkillIfTrusted(skillName, loadFn) {
  const { allowed, reasons } = await client.checkPolicy(skillName);
  if (!allowed) {
    throw new Error(`Skill "${skillName}" blocked: ${reasons.join(", ")}`);
  }
  return loadFn(skillName);
}

// LangChain example
const tool = await loadSkillIfTrusted("web-scraper-v2", (name) => {
  return new DynamicTool({ name, func: scrapeFn });
});

// CrewAI example
const task = await loadSkillIfTrusted("data-analysis-v1", (name) => {
  return new Task({ description: "Analyze data", tool: name });
});
```

## Constants

```javascript
const { SkillStatus, STATUS_LABELS, TIER_LABELS } = require("@skillbond/sdk");

SkillStatus.INACTIVE;    // 0
SkillStatus.ACTIVE;      // 1
SkillStatus.WITHDRAWING; // 2
SkillStatus.SLASHED;     // 3

STATUS_LABELS; // ["INACTIVE", "ACTIVE", "WITHDRAWING", "SLASHED"]
TIER_LABELS;   // ["NONE", "BASIC", "STANDARD", "PREMIUM"]
```

## License

MIT
