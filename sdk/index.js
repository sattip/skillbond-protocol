const { ethers } = require("ethers");
const ABI = require("./abi.json");

// Status enum matching the Solidity contract
const SkillStatus = Object.freeze({
  INACTIVE: 0,
  ACTIVE: 1,
  WITHDRAWING: 2,
  SLASHED: 3,
});

// Status labels for display
const STATUS_LABELS = ["INACTIVE", "ACTIVE", "WITHDRAWING", "SLASHED"];

// Trust tier labels
const TIER_LABELS = ["NONE", "BASIC", "STANDARD", "PREMIUM"];

// USDC uses 6 decimals
const USDC_DECIMALS = 6;

/**
 * SkillBondClient - JavaScript SDK for the SkillBond Protocol.
 *
 * Provides a clean interface for AI agents to check trust, stake skills,
 * flag malicious behavior, and enforce trust policies.
 *
 * @example
 * const client = new SkillBondClient({
 *   rpcUrl: "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY",
 *   contractAddress: "0x...",
 * });
 * const { trusted, tier } = await client.isSkillTrusted("my-skill-v1");
 */
class SkillBondClient {
  /**
   * @param {Object} options
   * @param {string} options.rpcUrl - JSON-RPC endpoint URL
   * @param {string} options.contractAddress - Deployed SkillBondRegistry address
   * @param {string} [options.usdcAddress] - USDC token address (read from contract if omitted)
   * @param {ethers.Signer} [options.signer] - Signer for write operations
   */
  constructor({ rpcUrl, contractAddress, usdcAddress, signer }) {
    if (!rpcUrl) throw new Error("rpcUrl is required");
    if (!contractAddress) throw new Error("contractAddress is required");

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.contractAddress = contractAddress;
    this.usdcAddress = usdcAddress || null;
    this.signer = signer || null;
    this.policy = null;

    // Read-only contract instance
    this.contract = new ethers.Contract(contractAddress, ABI, this.provider);

    // Writable contract instance (if signer provided)
    this._writableContract = null;
    if (this.signer) {
      this._initSigner(this.signer);
    }
  }

  /**
   * Attach a signer for write operations.
   * @param {ethers.Signer} signer
   */
  connect(signer) {
    this.signer = signer;
    this._initSigner(signer);
    return this;
  }

  /** @private */
  _initSigner(signer) {
    const connected = signer.provider ? signer : signer.connect(this.provider);
    this._writableContract = new ethers.Contract(
      this.contractAddress,
      ABI,
      connected
    );
    this._usdcContract = null; // lazily initialized
  }

  /** @private */
  _requireSigner() {
    if (!this._writableContract) {
      throw new Error(
        "Signer required for write operations. Pass a signer in the constructor or call .connect(signer)."
      );
    }
  }

  /** @private */
  async _getUsdcContract() {
    if (this._usdcContract) return this._usdcContract;
    if (!this.usdcAddress) {
      this.usdcAddress = await this.contract.usdc();
    }
    const usdcAbi = [
      "function approve(address spender, uint256 amount) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)",
      "function balanceOf(address account) view returns (uint256)",
    ];
    const signer = this._writableContract
      ? this._writableContract.runner
      : this.provider;
    this._usdcContract = new ethers.Contract(
      this.usdcAddress,
      usdcAbi,
      signer
    );
    return this._usdcContract;
  }

  // ---------- Utility ----------

  /**
   * Compute a skillId from a human-readable name (keccak256 hash).
   * @param {string} name - Skill name (e.g., "my-skill-v1")
   * @returns {string} bytes32 hex string
   */
  static skillId(name) {
    return ethers.id(name);
  }

  /**
   * Format a USDC amount from raw 6-decimal integer to human-readable string.
   * @param {bigint|string|number} raw - Raw USDC amount (6 decimals)
   * @returns {string} Human-readable amount (e.g., "25.00")
   */
  static formatUSDC(raw) {
    return ethers.formatUnits(raw, USDC_DECIMALS);
  }

  /**
   * Parse a human-readable USDC amount to raw 6-decimal integer.
   * @param {string|number} amount - Human-readable amount (e.g., "25")
   * @returns {bigint} Raw USDC amount (6 decimals)
   */
  static parseUSDC(amount) {
    return ethers.parseUnits(String(amount), USDC_DECIMALS);
  }

  // ---------- Read Operations (free, no gas) ----------

  /**
   * Check if a skill is trusted (active with stake > 0).
   * Accepts either a raw bytes32 skillId or a human-readable name.
   *
   * @param {string} skillIdOrName - bytes32 skillId or plain name
   * @returns {Promise<{trusted: boolean, stake: bigint, stakeFormatted: string, tier: number, tierLabel: string, status: number, statusLabel: string}>}
   */
  async isSkillTrusted(skillIdOrName) {
    const id = this._resolveSkillId(skillIdOrName);
    const [trustResult, tier] = await Promise.all([
      this.contract.isSkillTrusted(id),
      this.contract.getTrustTier(id),
    ]);

    const [trusted, stake] = trustResult;
    const status = Number(await this.contract.getSkillStatus(id));

    return {
      trusted,
      stake,
      stakeFormatted: SkillBondClient.formatUSDC(stake),
      tier: Number(tier),
      tierLabel: TIER_LABELS[Number(tier)] || "UNKNOWN",
      status,
      statusLabel: STATUS_LABELS[status] || "UNKNOWN",
    };
  }

  /**
   * Get the trust tier for a skill (0=none, 1=basic, 2=standard, 3=premium).
   * @param {string} skillIdOrName
   * @returns {Promise<number>}
   */
  async getTrustTier(skillIdOrName) {
    const id = this._resolveSkillId(skillIdOrName);
    return Number(await this.contract.getTrustTier(id));
  }

  /**
   * Get full skill bond details.
   * @param {string} skillIdOrName
   * @returns {Promise<{owner: string, stake: bigint, stakeFormatted: string, metadataURI: string, status: number, statusLabel: string, stakedAt: Date, flagCount: number, withdrawalInitiatedAt: number}>}
   */
  async getSkillBond(skillIdOrName) {
    const id = this._resolveSkillId(skillIdOrName);
    const result = await this.contract.getSkillBond(id);
    const [
      owner,
      stakeAmount,
      metadataURI,
      status,
      stakedAt,
      flagCount,
      withdrawalInitiatedAt,
    ] = result;

    return {
      owner,
      stake: stakeAmount,
      stakeFormatted: SkillBondClient.formatUSDC(stakeAmount),
      metadataURI,
      status: Number(status),
      statusLabel: STATUS_LABELS[Number(status)] || "UNKNOWN",
      stakedAt: new Date(Number(stakedAt) * 1000),
      flagCount: Number(flagCount),
      withdrawalInitiatedAt: Number(withdrawalInitiatedAt),
    };
  }

  /**
   * Batch query trust info for multiple skills in parallel.
   * @param {string[]} skillIdsOrNames - Array of skillIds or names
   * @returns {Promise<Array<{skillId: string, trusted: boolean, tier: number, tierLabel: string, stake: bigint, stakeFormatted: string, status: number, statusLabel: string}>>}
   */
  async batchQueryTrust(skillIdsOrNames) {
    const queries = skillIdsOrNames.map((name) => this.isSkillTrusted(name));
    const results = await Promise.all(queries);
    return results.map((r, i) => ({
      skillId: this._resolveSkillId(skillIdsOrNames[i]),
      ...r,
    }));
  }

  /**
   * Get protocol-wide statistics.
   * @returns {Promise<{registered: number, slashed: number, bountiesPaid: bigint, insurance: bigint}>}
   */
  async getStats() {
    const [registered, slashed, bountiesPaid, insurance] =
      await this.contract.getStats();
    return {
      registered: Number(registered),
      slashed: Number(slashed),
      bountiesPaid,
      bountiesPaidFormatted: SkillBondClient.formatUSDC(bountiesPaid),
      insurance,
      insuranceFormatted: SkillBondClient.formatUSDC(insurance),
    };
  }

  // ---------- Write Operations (require signer) ----------

  /**
   * Register a skill by staking USDC. Automatically approves the token transfer.
   * @param {string} skillIdOrName - bytes32 skillId or plain name
   * @param {string} metadataURI - Link to skill manifest (IPFS, GitHub, etc.)
   * @param {string|number} amount - USDC amount to stake (human-readable, e.g., "100")
   * @returns {Promise<ethers.TransactionResponse>}
   */
  async stakeSkill(skillIdOrName, metadataURI, amount) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);
    const rawAmount = SkillBondClient.parseUSDC(amount);

    await this._ensureApproval(rawAmount);
    return this._writableContract.stakeSkill(id, metadataURI, rawAmount);
  }

  /**
   * Flag a skill as potentially malicious. Requires a 50% counter-stake.
   * @param {string} skillIdOrName
   * @param {string} evidenceHash - bytes32 hash of evidence
   * @returns {Promise<ethers.TransactionResponse>}
   */
  async flagSkill(skillIdOrName, evidenceHash) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);

    // Get the skill's stake to compute required counter-stake
    const bond = await this.contract.getSkillBond(id);
    const counterStake = (bond[1] * 5000n) / 10000n; // 50% of stake
    await this._ensureApproval(counterStake);

    return this._writableContract.flagSkill(id, evidenceHash);
  }

  /**
   * Paid trust query (x402-style). Charges 0.05 USDC, returns trust data.
   * @param {string} skillIdOrName
   * @returns {Promise<{tier: number, tierLabel: string, status: number, statusLabel: string, stake: bigint, stakeFormatted: string, age: number, tx: ethers.TransactionResponse}>}
   */
  async queryTrust(skillIdOrName) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);

    // Approve the 0.05 USDC query fee
    const queryFee = 50000n; // 0.05 USDC
    await this._ensureApproval(queryFee);

    const tx = await this._writableContract.queryTrust(id);
    const receipt = await tx.wait();

    // Parse the TrustQueried event to get return values
    const iface = new ethers.Interface(ABI);
    const log = receipt.logs
      .map((l) => {
        try {
          return iface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((l) => l && l.name === "TrustQueried");

    // Since queryTrust is a state-changing function, we need to call it
    // as a static call to get the return values, then send the actual tx.
    // Re-read the state after the tx is mined.
    const bond = await this.contract.getSkillBond(id);
    const tier = await this.contract.getTrustTier(id);

    return {
      tier: Number(tier),
      tierLabel: TIER_LABELS[Number(tier)] || "UNKNOWN",
      status: Number(bond[3]),
      statusLabel: STATUS_LABELS[Number(bond[3])] || "UNKNOWN",
      stake: bond[1],
      stakeFormatted: SkillBondClient.formatUSDC(bond[1]),
      age: Math.floor(Date.now() / 1000) - Number(bond[4]),
      tx,
    };
  }

  /**
   * Sponsor a skill by adding USDC to its stake. Increases tier potential.
   * @param {string} skillIdOrName
   * @param {string|number} amount - USDC amount to sponsor (human-readable)
   * @returns {Promise<ethers.TransactionResponse>}
   */
  async sponsorSkill(skillIdOrName, amount) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);
    const rawAmount = SkillBondClient.parseUSDC(amount);

    await this._ensureApproval(rawAmount);
    return this._writableContract.sponsorSkill(id, rawAmount);
  }

  /**
   * Initiate withdrawal of a skill's stake. Starts the 7-day cooldown.
   * @param {string} skillIdOrName
   * @returns {Promise<ethers.TransactionResponse>}
   */
  async initiateWithdrawal(skillIdOrName) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);
    return this._writableContract.initiateWithdrawal(id);
  }

  /**
   * Complete withdrawal after the 7-day cooldown period.
   * @param {string} skillIdOrName
   * @returns {Promise<ethers.TransactionResponse>}
   */
  async completeWithdrawal(skillIdOrName) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);
    return this._writableContract.completeWithdrawal(id);
  }

  /**
   * Cancel an in-progress withdrawal and return the skill to ACTIVE status.
   * @param {string} skillIdOrName
   * @returns {Promise<ethers.TransactionResponse>}
   */
  async cancelWithdrawal(skillIdOrName) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);
    return this._writableContract.cancelWithdrawal(id);
  }

  /**
   * Claim accumulated query fees for a skill you own.
   * @param {string} skillIdOrName
   * @returns {Promise<ethers.TransactionResponse>}
   */
  async claimFees(skillIdOrName) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);
    return this._writableContract.claimFees(id);
  }

  /**
   * Withdraw your sponsorship stake from a skill (after cooldown).
   * @param {string} skillIdOrName
   * @returns {Promise<ethers.TransactionResponse>}
   */
  async withdrawSponsorship(skillIdOrName) {
    this._requireSigner();
    const id = this._resolveSkillId(skillIdOrName);
    return this._writableContract.withdrawSponsorship(id);
  }

  // ---------- Policy Enforcement (local, no RPC unless checking) ----------

  /**
   * Set a local trust policy. Skills that fail the policy are rejected.
   *
   * @param {Object} policy
   * @param {string|number} [policy.minStake] - Minimum USDC stake (human-readable, e.g., "100")
   * @param {number} [policy.minTier] - Minimum trust tier (0-3)
   * @param {number} [policy.minAge] - Minimum age in seconds
   * @param {string[]} [policy.maxPermissions] - List of allowed permission types
   */
  setPolicy({ minStake, minTier, minAge, maxPermissions } = {}) {
    this.policy = {
      minStake: minStake ? SkillBondClient.parseUSDC(minStake) : null,
      minTier: minTier ?? null,
      minAge: minAge ?? null,
      maxPermissions: maxPermissions ?? null,
    };
    return this;
  }

  /**
   * Check if a skill passes the current policy. Returns { allowed, reasons }.
   * @param {string} skillIdOrName
   * @returns {Promise<{allowed: boolean, reasons: string[]}>}
   */
  async checkPolicy(skillIdOrName) {
    if (!this.policy) {
      throw new Error("No policy set. Call setPolicy() first.");
    }

    const id = this._resolveSkillId(skillIdOrName);
    const reasons = [];

    // Fetch trust data and bond data in parallel
    const [trustResult, bond, tier] = await Promise.all([
      this.contract.isSkillTrusted(id),
      this.contract.getSkillBond(id),
      this.contract.getTrustTier(id),
    ]);

    const [trusted, stake] = trustResult;
    const status = Number(bond[3]);
    const stakedAt = Number(bond[4]);
    const age = Math.floor(Date.now() / 1000) - stakedAt;

    // Check: is the skill active?
    if (!trusted) {
      reasons.push(
        `Skill is not trusted (status: ${STATUS_LABELS[status] || "UNKNOWN"})`
      );
    }

    // Check: minimum stake
    if (this.policy.minStake !== null && stake < this.policy.minStake) {
      reasons.push(
        `Stake ${SkillBondClient.formatUSDC(stake)} USDC is below minimum ${SkillBondClient.formatUSDC(this.policy.minStake)} USDC`
      );
    }

    // Check: minimum tier
    if (this.policy.minTier !== null && Number(tier) < this.policy.minTier) {
      reasons.push(
        `Trust tier ${Number(tier)} (${TIER_LABELS[Number(tier)]}) is below minimum tier ${this.policy.minTier} (${TIER_LABELS[this.policy.minTier]})`
      );
    }

    // Check: minimum age
    if (this.policy.minAge !== null && stakedAt > 0 && age < this.policy.minAge) {
      const ageDays = Math.floor(age / 86400);
      const requiredDays = Math.floor(this.policy.minAge / 86400);
      reasons.push(
        `Skill age ${ageDays} days is below minimum ${requiredDays} days`
      );
    }

    return {
      allowed: reasons.length === 0,
      reasons,
    };
  }

  // ---------- Event Listeners ----------

  /**
   * Listen for SkillStaked events.
   * @param {Function} callback - Called with (skillId, owner, amount, metadataURI, event)
   * @returns {ethers.Contract} The contract (for removing listener)
   */
  onSkillStaked(callback) {
    this.contract.on("SkillStaked", callback);
    return this.contract;
  }

  /**
   * Listen for SkillFlagged events.
   * @param {Function} callback - Called with (skillId, flagger, flagCount, counterStake, evidenceHash, event)
   * @returns {ethers.Contract}
   */
  onSkillFlagged(callback) {
    this.contract.on("SkillFlagged", callback);
    return this.contract;
  }

  /**
   * Listen for SkillSlashed events.
   * @param {Function} callback - Called with (skillId, whistleblower, bounty, burned, event)
   * @returns {ethers.Contract}
   */
  onSkillSlashed(callback) {
    this.contract.on("SkillSlashed", callback);
    return this.contract;
  }

  /**
   * Remove all event listeners.
   */
  removeAllListeners() {
    this.contract.removeAllListeners();
  }

  // ---------- Private Helpers ----------

  /** @private Resolve a skill name to bytes32 if needed */
  _resolveSkillId(skillIdOrName) {
    // Already a bytes32 hex string (0x + 64 hex chars)
    if (
      typeof skillIdOrName === "string" &&
      skillIdOrName.startsWith("0x") &&
      skillIdOrName.length === 66
    ) {
      return skillIdOrName;
    }
    return SkillBondClient.skillId(skillIdOrName);
  }

  /** @private Ensure USDC approval for contract spending */
  async _ensureApproval(amount) {
    const usdc = await this._getUsdcContract();
    const signerAddress = await this._writableContract.runner.getAddress();
    const currentAllowance = await usdc.allowance(
      signerAddress,
      this.contractAddress
    );
    if (currentAllowance < amount) {
      const tx = await usdc.approve(this.contractAddress, amount);
      await tx.wait();
    }
  }
}

module.exports = { SkillBondClient, SkillStatus, STATUS_LABELS, TIER_LABELS };
