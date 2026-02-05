const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SkillBondRegistry", function () {
  let registry, usdc;
  let admin, skillOwner, hunter, randomUser, flagger2, flagger3;
  const USDC = 10n ** 6n;
  const STAKE_AMOUNT = 25n * USDC;
  const STANDARD_STAKE = 500n * USDC;
  const PREMIUM_STAKE = 10000n * USDC;
  const SKILL_ID = ethers.keccak256(ethers.toUtf8Bytes("weather-skill-v1"));
  const FLAG_THRESHOLD = 3;
  const SEVEN_DAYS = 7 * 24 * 60 * 60;
  const THIRTY_DAYS = 30 * 24 * 60 * 60;
  const NINETY_DAYS = 90 * 24 * 60 * 60;

  // Status enum values
  const INACTIVE = 0;
  const ACTIVE = 1;
  const WITHDRAWING = 2;
  const SLASHED = 3;

  beforeEach(async function () {
    [admin, skillOwner, hunter, randomUser, flagger2, flagger3] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockUSDC");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const Registry = await ethers.getContractFactory("SkillBondRegistry");
    registry = await Registry.deploy(await usdc.getAddress(), FLAG_THRESHOLD);
    await registry.waitForDeployment();

    const registryAddr = await registry.getAddress();

    // Mint USDC to all participants
    await usdc.mint(skillOwner.address, 50000n * USDC);
    await usdc.mint(hunter.address, 10000n * USDC);
    await usdc.mint(randomUser.address, 5000n * USDC);
    await usdc.mint(flagger2.address, 5000n * USDC);
    await usdc.mint(flagger3.address, 5000n * USDC);

    // Approve registry for all participants
    await usdc.connect(skillOwner).approve(registryAddr, 50000n * USDC);
    await usdc.connect(hunter).approve(registryAddr, 10000n * USDC);
    await usdc.connect(randomUser).approve(registryAddr, 5000n * USDC);
    await usdc.connect(flagger2).approve(registryAddr, 5000n * USDC);
    await usdc.connect(flagger3).approve(registryAddr, 5000n * USDC);
  });

  // Helper: advance time
  async function increaseTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine");
  }

  // Helper: stake a skill
  async function stakeSkill(signer, skillId, amount) {
    await registry.connect(signer).stakeSkill(skillId, "ipfs://metadata", amount);
  }

  // Helper: flag a skill
  async function flagSkill(signer, skillId) {
    await registry.connect(signer).flagSkill(skillId);
  }

  // ================================================================
  // STAKING (4 tests)
  // ================================================================
  describe("Staking", function () {
    it("should allow registering a skill with USDC", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      const [trusted, stake] = await registry.isSkillTrusted(SKILL_ID);
      expect(trusted).to.be.true;
      expect(stake).to.equal(STAKE_AMOUNT);
    });

    it("should reject stake below minimum (25 USDC)", async function () {
      await expect(
        registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", 10n * USDC)
      ).to.be.revertedWith("Below minimum stake");
    });

    it("should reject duplicate skill registration", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await expect(
        registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata2", STAKE_AMOUNT)
      ).to.be.revertedWith("Skill already registered");
    });

    it("should set status to ACTIVE after staking", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      const status = await registry.getSkillStatus(SKILL_ID);
      expect(status).to.equal(ACTIVE);
    });
  });

  // ================================================================
  // FLAGGING WITH COUNTER-STAKE (6 tests)
  // ================================================================
  describe("Flagging with Counter-stake", function () {
    beforeEach(async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
    });

    it("should require counter-stake (50% of target's stake)", async function () {
      const hunterBalBefore = await usdc.balanceOf(hunter.address);
      await flagSkill(hunter, SKILL_ID);
      const hunterBalAfter = await usdc.balanceOf(hunter.address);

      const expectedCounterStake = (STAKE_AMOUNT * 5000n) / 10000n;
      expect(hunterBalBefore - hunterBalAfter).to.equal(expectedCounterStake);

      // Verify counter-stake stored
      const stored = await registry.counterStakes(SKILL_ID, hunter.address);
      expect(stored).to.equal(expectedCounterStake);
    });

    it("should fail without sufficient USDC approval", async function () {
      const signers = await ethers.getSigners();
      const noApproval = signers[6];
      await usdc.mint(noApproval.address, 5000n * USDC);
      // Do NOT approve the registry
      await expect(
        registry.connect(noApproval).flagSkill(SKILL_ID)
      ).to.be.revertedWith("Insufficient allowance");
    });

    it("should prevent double-flagging", async function () {
      await flagSkill(hunter, SKILL_ID);
      await expect(
        registry.connect(hunter).flagSkill(SKILL_ID)
      ).to.be.revertedWith("Already flagged");
    });

    it("should prevent self-flagging", async function () {
      await expect(
        registry.connect(skillOwner).flagSkill(SKILL_ID)
      ).to.be.revertedWith("Cannot flag own skill");
    });

    it("should track first flagger", async function () {
      await flagSkill(hunter, SKILL_ID);
      await flagSkill(randomUser, SKILL_ID);

      const bond = await registry.getSkillBond(SKILL_ID);
      expect(bond.flagCount).to.equal(2);
      // First flagger is hunter — verified by community slash bounty payout later
      // We can also check via the firstFlagger field in the struct
      // But getSkillBond doesn't return firstFlagger, so we verify via community slash test
    });

    it("should emit SkillFlagged event with counter-stake amount", async function () {
      const expectedCounterStake = (STAKE_AMOUNT * 5000n) / 10000n;
      await expect(registry.connect(hunter).flagSkill(SKILL_ID))
        .to.emit(registry, "SkillFlagged")
        .withArgs(SKILL_ID, hunter.address, 1, expectedCounterStake);
    });
  });

  // ================================================================
  // ADMIN SLASH (6 tests)
  // ================================================================
  describe("Admin Slash", function () {
    beforeEach(async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await flagSkill(hunter, SKILL_ID);
    });

    it("should slash and pay whistleblower 80% bounty + return counter-stake", async function () {
      const counterStake = (STAKE_AMOUNT * 5000n) / 10000n;
      const bounty = (STAKE_AMOUNT * 8000n) / 10000n;
      const expectedPayout = bounty + counterStake;

      const hunterBalBefore = await usdc.balanceOf(hunter.address);
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const hunterBalAfter = await usdc.balanceOf(hunter.address);

      expect(hunterBalAfter - hunterBalBefore).to.equal(expectedPayout);
    });

    it("should add 20% to insurance fund", async function () {
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const burned = STAKE_AMOUNT - (STAKE_AMOUNT * 8000n) / 10000n;
      expect(await registry.insuranceFund()).to.equal(burned);
    });

    it("should set status to SLASHED (enum value 3)", async function () {
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const status = await registry.getSkillStatus(SKILL_ID);
      expect(status).to.equal(SLASHED);
    });

    it("should prevent double slash", async function () {
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      await expect(
        registry.connect(admin).executeSlash(SKILL_ID, hunter.address)
      ).to.be.revertedWith("Already slashed");
    });

    it("should only allow admin to slash", async function () {
      await expect(
        registry.connect(hunter).executeSlash(SKILL_ID, hunter.address)
      ).to.be.revertedWith("Only admin");
    });

    it("should update protocol stats", async function () {
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const stats = await registry.getStats();
      expect(stats[0]).to.equal(1); // totalSkillsRegistered
      expect(stats[1]).to.equal(1); // totalSlashed
      const bounty = (STAKE_AMOUNT * 8000n) / 10000n;
      expect(stats[2]).to.equal(bounty); // totalBountiesPaid
      const burned = STAKE_AMOUNT - bounty;
      expect(stats[3]).to.equal(burned); // insuranceFund
    });
  });

  // ================================================================
  // COMMUNITY SLASH (5 tests)
  // ================================================================
  describe("Community Slash", function () {
    beforeEach(async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
    });

    it("should reject community slash below flag threshold", async function () {
      await flagSkill(hunter, SKILL_ID);
      await flagSkill(randomUser, SKILL_ID);
      // Only 2 flags, threshold is 3
      await expect(
        registry.connect(randomUser).communitySlash(SKILL_ID)
      ).to.be.revertedWith("Below flag threshold");
    });

    it("should execute community slash when threshold is met", async function () {
      await flagSkill(hunter, SKILL_ID);
      await flagSkill(randomUser, SKILL_ID);
      await flagSkill(flagger2, SKILL_ID);

      const signers = await ethers.getSigners();
      await registry.connect(signers[6]).communitySlash(SKILL_ID);

      const [trusted] = await registry.isSkillTrusted(SKILL_ID);
      expect(trusted).to.be.false;

      const status = await registry.getSkillStatus(SKILL_ID);
      expect(status).to.equal(SLASHED);
    });

    it("should pay first flagger bounty + return their counter-stake", async function () {
      await flagSkill(hunter, SKILL_ID);
      await flagSkill(randomUser, SKILL_ID);
      await flagSkill(flagger2, SKILL_ID);

      const counterStake = (STAKE_AMOUNT * 5000n) / 10000n;
      const bounty = (STAKE_AMOUNT * 8000n) / 10000n;
      const expectedPayout = bounty + counterStake;

      const hunterBalBefore = await usdc.balanceOf(hunter.address);
      const signers = await ethers.getSigners();
      await registry.connect(signers[6]).communitySlash(SKILL_ID);
      const hunterBalAfter = await usdc.balanceOf(hunter.address);

      expect(hunterBalAfter - hunterBalBefore).to.equal(expectedPayout);
    });

    it("should reject community slash when disabled (threshold=0)", async function () {
      const Registry = await ethers.getContractFactory("SkillBondRegistry");
      const noThresholdRegistry = await Registry.deploy(await usdc.getAddress(), 0);
      await noThresholdRegistry.waitForDeployment();

      const regAddr = await noThresholdRegistry.getAddress();
      await usdc.connect(skillOwner).approve(regAddr, STAKE_AMOUNT);
      const skillId2 = ethers.keccak256(ethers.toUtf8Bytes("test-v2"));
      await noThresholdRegistry.connect(skillOwner).stakeSkill(skillId2, "ipfs://m", STAKE_AMOUNT);

      await usdc.connect(hunter).approve(regAddr, 5000n * USDC);
      await noThresholdRegistry.connect(hunter).flagSkill(skillId2);

      await expect(
        noThresholdRegistry.connect(randomUser).communitySlash(skillId2)
      ).to.be.revertedWith("Community slash disabled");
    });

    it("should work on WITHDRAWING skills", async function () {
      await flagSkill(hunter, SKILL_ID);
      await flagSkill(randomUser, SKILL_ID);
      await flagSkill(flagger2, SKILL_ID);

      // Owner initiates withdrawal
      await registry.connect(skillOwner).initiateWithdrawal(SKILL_ID);
      const status = await registry.getSkillStatus(SKILL_ID);
      expect(status).to.equal(WITHDRAWING);

      // Community slash should still work
      const signers = await ethers.getSigners();
      await registry.connect(signers[6]).communitySlash(SKILL_ID);

      const newStatus = await registry.getSkillStatus(SKILL_ID);
      expect(newStatus).to.equal(SLASHED);
    });
  });

  // ================================================================
  // TRUST TIERS WITH AGE (8 tests)
  // ================================================================
  describe("Trust Tiers with Age", function () {
    it("should return tier 0 for unregistered skill", async function () {
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(0);
    });

    it("should return tier 1 for basic stake (25 USDC, 0 days)", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(1);
    });

    it("should return tier 1 for standard-amount stake but < 30 days age", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STANDARD_STAKE);
      // No time advancement, age < 30 days
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(1);
    });

    it("should return tier 2 for standard stake (500 USDC) after 30 days", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STANDARD_STAKE);
      await increaseTime(THIRTY_DAYS + 1);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(2);
    });

    it("should return tier 2 for premium-amount stake but < 90 days age", async function () {
      await stakeSkill(skillOwner, SKILL_ID, PREMIUM_STAKE);
      // Advance 31 days — enough for tier 2 age, but not tier 3
      await increaseTime(THIRTY_DAYS + 1);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(2);
    });

    it("should return tier 3 for premium stake (10K USDC) after 90 days", async function () {
      await stakeSkill(skillOwner, SKILL_ID, PREMIUM_STAKE);
      await increaseTime(NINETY_DAYS + 1);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(3);
    });

    it("should return tier 0 for slashed skill", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await flagSkill(hunter, SKILL_ID);
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(0);
    });

    it("isSkillTrustedAtTier should respect age checks", async function () {
      await stakeSkill(skillOwner, SKILL_ID, PREMIUM_STAKE);

      // Immediately after staking — tier 1 only (no age)
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 1)).to.be.true;
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 2)).to.be.false;
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 3)).to.be.false;

      // After 30 days — tier 2
      await increaseTime(THIRTY_DAYS + 1);
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 2)).to.be.true;
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 3)).to.be.false;

      // After 90 days total — tier 3
      await increaseTime(NINETY_DAYS - THIRTY_DAYS);
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 3)).to.be.true;
    });
  });

  // ================================================================
  // WITHDRAWAL FLOW (6 tests)
  // ================================================================
  describe("Withdrawal Flow", function () {
    beforeEach(async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
    });

    it("initiateWithdrawal should set status to WITHDRAWING", async function () {
      await registry.connect(skillOwner).initiateWithdrawal(SKILL_ID);
      const status = await registry.getSkillStatus(SKILL_ID);
      expect(status).to.equal(WITHDRAWING);
    });

    it("completeWithdrawal should reject during cooldown", async function () {
      await registry.connect(skillOwner).initiateWithdrawal(SKILL_ID);
      // Try to complete immediately (before 7-day cooldown)
      await expect(
        registry.connect(skillOwner).completeWithdrawal(SKILL_ID)
      ).to.be.revertedWith("Cooldown active");
    });

    it("completeWithdrawal should succeed after 7-day cooldown", async function () {
      await registry.connect(skillOwner).initiateWithdrawal(SKILL_ID);
      await increaseTime(SEVEN_DAYS + 1);

      const balBefore = await usdc.balanceOf(skillOwner.address);
      await registry.connect(skillOwner).completeWithdrawal(SKILL_ID);
      const balAfter = await usdc.balanceOf(skillOwner.address);

      expect(balAfter - balBefore).to.equal(STAKE_AMOUNT);

      const status = await registry.getSkillStatus(SKILL_ID);
      expect(status).to.equal(INACTIVE);
    });

    it("cancelWithdrawal should restore status to ACTIVE", async function () {
      await registry.connect(skillOwner).initiateWithdrawal(SKILL_ID);
      expect(await registry.getSkillStatus(SKILL_ID)).to.equal(WITHDRAWING);

      await registry.connect(skillOwner).cancelWithdrawal(SKILL_ID);
      expect(await registry.getSkillStatus(SKILL_ID)).to.equal(ACTIVE);
    });

    it("should not allow withdrawal of slashed skill", async function () {
      await flagSkill(hunter, SKILL_ID);
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);

      await expect(
        registry.connect(skillOwner).initiateWithdrawal(SKILL_ID)
      ).to.be.revertedWith("Skill not active");
    });

    it("WITHDRAWING skill: isSkillTrusted should return false, getTrustTier should return 0", async function () {
      await registry.connect(skillOwner).initiateWithdrawal(SKILL_ID);

      const [trusted] = await registry.isSkillTrusted(SKILL_ID);
      expect(trusted).to.be.false;

      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(0);
    });
  });

  // ================================================================
  // DISMISS FLAG (3 tests)
  // ================================================================
  describe("Dismiss Flag", function () {
    beforeEach(async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await flagSkill(hunter, SKILL_ID);
    });

    it("should slash flagger's counter-stake to insurance fund", async function () {
      const counterStake = (STAKE_AMOUNT * 5000n) / 10000n;
      const insuranceBefore = await registry.insuranceFund();

      await registry.connect(admin).dismissFlag(SKILL_ID, hunter.address);

      const insuranceAfter = await registry.insuranceFund();
      expect(insuranceAfter - insuranceBefore).to.equal(counterStake);
    });

    it("should decrement flag count", async function () {
      const bondBefore = await registry.getSkillBond(SKILL_ID);
      expect(bondBefore.flagCount).to.equal(1);

      await registry.connect(admin).dismissFlag(SKILL_ID, hunter.address);

      const bondAfter = await registry.getSkillBond(SKILL_ID);
      expect(bondAfter.flagCount).to.equal(0);
    });

    it("should only allow admin to dismiss flags", async function () {
      await expect(
        registry.connect(hunter).dismissFlag(SKILL_ID, hunter.address)
      ).to.be.revertedWith("Only admin");
    });
  });

  // ================================================================
  // RECLAIM COUNTER-STAKE (3 tests)
  // ================================================================
  describe("Reclaim Counter-stake", function () {
    beforeEach(async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
    });

    it("should allow reclaim after slash", async function () {
      // Hunter flags, randomUser also flags
      await flagSkill(hunter, SKILL_ID);
      await flagSkill(randomUser, SKILL_ID);

      const counterStake = (STAKE_AMOUNT * 5000n) / 10000n;

      // Admin slashes, hunter gets bounty + their counter-stake back
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);

      // randomUser should be able to reclaim their counter-stake
      const balBefore = await usdc.balanceOf(randomUser.address);
      await registry.connect(randomUser).reclaimCounterStake(SKILL_ID);
      const balAfter = await usdc.balanceOf(randomUser.address);

      expect(balAfter - balBefore).to.equal(counterStake);
    });

    it("should reject reclaim if skill not slashed", async function () {
      await flagSkill(hunter, SKILL_ID);
      await expect(
        registry.connect(hunter).reclaimCounterStake(SKILL_ID)
      ).to.be.revertedWith("Skill not slashed");
    });

    it("should reject reclaim if no counter-stake", async function () {
      await flagSkill(hunter, SKILL_ID);
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);

      // flagger2 never flagged, so no counter-stake
      await expect(
        registry.connect(flagger2).reclaimCounterStake(SKILL_ID)
      ).to.be.revertedWith("No counter-stake");
    });
  });

  // ================================================================
  // ADMIN (2 tests)
  // ================================================================
  describe("Admin", function () {
    it("should allow admin transfer", async function () {
      await expect(registry.connect(admin).transferAdmin(hunter.address))
        .to.emit(registry, "AdminTransferred")
        .withArgs(admin.address, hunter.address);

      // New admin should be able to act
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await flagSkill(randomUser, SKILL_ID);
      await registry.connect(hunter).executeSlash(SKILL_ID, randomUser.address);

      // Old admin should fail
      const skillId2 = ethers.keccak256(ethers.toUtf8Bytes("skill-2"));
      await stakeSkill(skillOwner, skillId2, STAKE_AMOUNT);
      await flagSkill(flagger2, skillId2);
      await expect(
        registry.connect(admin).executeSlash(skillId2, flagger2.address)
      ).to.be.revertedWith("Only admin");
    });

    it("should allow admin to update flag threshold", async function () {
      await expect(registry.connect(admin).setFlagThreshold(5))
        .to.emit(registry, "FlagThresholdUpdated")
        .withArgs(3, 5);
      expect(await registry.flagThreshold()).to.equal(5);
    });
  });

  // ================================================================
  // EVENTS (additional event tests)
  // ================================================================
  describe("Events", function () {
    it("should emit SkillStaked on registration", async function () {
      await expect(registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", STAKE_AMOUNT))
        .to.emit(registry, "SkillStaked")
        .withArgs(SKILL_ID, skillOwner.address, STAKE_AMOUNT, "ipfs://metadata");
    });

    it("should emit SkillWithdrawalInitiated on initiate", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await expect(registry.connect(skillOwner).initiateWithdrawal(SKILL_ID))
        .to.emit(registry, "SkillWithdrawalInitiated");
    });

    it("should emit SkillWithdrawalCancelled on cancel", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await registry.connect(skillOwner).initiateWithdrawal(SKILL_ID);
      await expect(registry.connect(skillOwner).cancelWithdrawal(SKILL_ID))
        .to.emit(registry, "SkillWithdrawalCancelled")
        .withArgs(SKILL_ID, skillOwner.address);
    });

    it("should emit SkillWithdrawn on complete withdrawal", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await registry.connect(skillOwner).initiateWithdrawal(SKILL_ID);
      await increaseTime(SEVEN_DAYS + 1);
      await expect(registry.connect(skillOwner).completeWithdrawal(SKILL_ID))
        .to.emit(registry, "SkillWithdrawn")
        .withArgs(SKILL_ID, skillOwner.address, STAKE_AMOUNT);
    });

    it("should emit FlagDismissed on dismiss", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await flagSkill(hunter, SKILL_ID);
      const counterStake = (STAKE_AMOUNT * 5000n) / 10000n;
      await expect(registry.connect(admin).dismissFlag(SKILL_ID, hunter.address))
        .to.emit(registry, "FlagDismissed")
        .withArgs(SKILL_ID, hunter.address, counterStake);
    });

    it("should emit SkillSlashed on admin slash", async function () {
      await stakeSkill(skillOwner, SKILL_ID, STAKE_AMOUNT);
      await flagSkill(hunter, SKILL_ID);
      const bounty = (STAKE_AMOUNT * 8000n) / 10000n;
      const burned = STAKE_AMOUNT - bounty;
      await expect(registry.connect(admin).executeSlash(SKILL_ID, hunter.address))
        .to.emit(registry, "SkillSlashed")
        .withArgs(SKILL_ID, hunter.address, bounty, burned);
    });
  });
});
