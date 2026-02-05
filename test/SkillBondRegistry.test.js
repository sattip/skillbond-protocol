const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SkillBondRegistry", function () {
  let registry, usdc;
  let admin, skillOwner, hunter, randomUser;
  const STAKE_AMOUNT = 100n * 10n ** 6n;
  const SKILL_ID = ethers.keccak256(ethers.toUtf8Bytes("test-skill-v1.0"));
  const FLAG_THRESHOLD = 3;

  beforeEach(async function () {
    [admin, skillOwner, hunter, randomUser] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockUSDC");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const Registry = await ethers.getContractFactory("SkillBondRegistry");
    registry = await Registry.deploy(await usdc.getAddress(), FLAG_THRESHOLD);
    await registry.waitForDeployment();

    await usdc.mint(skillOwner.address, 50000n * 10n ** 6n);
    await usdc.connect(skillOwner).approve(await registry.getAddress(), 50000n * 10n ** 6n);
  });

  describe("Staking", function () {
    it("should allow staking a skill with USDC", async function () {
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", STAKE_AMOUNT);
      const [trusted, stake] = await registry.isSkillTrusted(SKILL_ID);
      expect(trusted).to.be.true;
      expect(stake).to.equal(STAKE_AMOUNT);
    });

    it("should reject stake below minimum", async function () {
      await expect(
        registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", 50n * 10n ** 6n)
      ).to.be.revertedWith("Below minimum stake");
    });

    it("should reject duplicate skill registration", async function () {
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", STAKE_AMOUNT);
      await expect(
        registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata2", STAKE_AMOUNT)
      ).to.be.revertedWith("Skill already registered");
    });

    it("should emit SkillStaked event", async function () {
      await expect(registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", STAKE_AMOUNT))
        .to.emit(registry, "SkillStaked")
        .withArgs(SKILL_ID, skillOwner.address, STAKE_AMOUNT, "ipfs://metadata");
    });
  });

  describe("Flagging", function () {
    beforeEach(async function () {
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", STAKE_AMOUNT);
    });

    it("should allow flagging a skill", async function () {
      await registry.connect(hunter).flagSkill(SKILL_ID);
      const bond = await registry.getSkillBond(SKILL_ID);
      expect(bond.flagCount).to.equal(1);
    });

    it("should prevent double-flagging", async function () {
      await registry.connect(hunter).flagSkill(SKILL_ID);
      await expect(registry.connect(hunter).flagSkill(SKILL_ID))
        .to.be.revertedWith("Already flagged");
    });

    it("should prevent self-flagging", async function () {
      await expect(registry.connect(skillOwner).flagSkill(SKILL_ID))
        .to.be.revertedWith("Cannot flag own skill");
    });

    it("should track the first flagger", async function () {
      await registry.connect(hunter).flagSkill(SKILL_ID);
      await registry.connect(randomUser).flagSkill(SKILL_ID);
      // First flagger is stored internally — verify via community slash later
      const bond = await registry.getSkillBond(SKILL_ID);
      expect(bond.flagCount).to.equal(2);
    });
  });

  describe("Slashing (Admin)", function () {
    beforeEach(async function () {
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", STAKE_AMOUNT);
      await registry.connect(hunter).flagSkill(SKILL_ID);
    });

    it("should slash skill and pay whistleblower 80%", async function () {
      const hunterBalBefore = await usdc.balanceOf(hunter.address);
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const hunterBalAfter = await usdc.balanceOf(hunter.address);
      const bounty = (STAKE_AMOUNT * 8000n) / 10000n;
      expect(hunterBalAfter - hunterBalBefore).to.equal(bounty);
    });

    it("should add 20% to insurance fund", async function () {
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const burned = STAKE_AMOUNT - (STAKE_AMOUNT * 8000n) / 10000n;
      expect(await registry.insuranceFund()).to.equal(burned);
    });

    it("should mark skill as slashed and untrusted", async function () {
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const [trusted] = await registry.isSkillTrusted(SKILL_ID);
      expect(trusted).to.be.false;
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
      expect(stats[0]).to.equal(1);
      expect(stats[1]).to.equal(1);
      expect(stats[2]).to.equal(80n * 10n ** 6n);
      expect(stats[3]).to.equal(20n * 10n ** 6n);
    });
  });

  describe("Community Slash (Decentralized)", function () {
    let signers;

    beforeEach(async function () {
      signers = await ethers.getSigners();
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", STAKE_AMOUNT);
    });

    it("should reject community slash below flag threshold", async function () {
      await registry.connect(hunter).flagSkill(SKILL_ID);
      await registry.connect(randomUser).flagSkill(SKILL_ID);
      // Only 2 flags, threshold is 3
      await expect(
        registry.connect(randomUser).communitySlash(SKILL_ID)
      ).to.be.revertedWith("Below flag threshold");
    });

    it("should execute community slash when threshold is met", async function () {
      // 3 independent agents flag
      await registry.connect(signers[2]).flagSkill(SKILL_ID);
      await registry.connect(signers[3]).flagSkill(SKILL_ID);
      await registry.connect(signers[4]).flagSkill(SKILL_ID);

      const firstFlaggerBefore = await usdc.balanceOf(signers[2].address);
      // Anyone can call communitySlash now
      await registry.connect(signers[5]).communitySlash(SKILL_ID);
      const firstFlaggerAfter = await usdc.balanceOf(signers[2].address);

      const bounty = (STAKE_AMOUNT * 8000n) / 10000n;
      expect(firstFlaggerAfter - firstFlaggerBefore).to.equal(bounty);

      const [trusted] = await registry.isSkillTrusted(SKILL_ID);
      expect(trusted).to.be.false;
    });

    it("should pay the first flagger on community slash", async function () {
      await registry.connect(hunter).flagSkill(SKILL_ID);
      await registry.connect(randomUser).flagSkill(SKILL_ID);
      await registry.connect(signers[4]).flagSkill(SKILL_ID);

      const hunterBefore = await usdc.balanceOf(hunter.address);
      await registry.connect(signers[5]).communitySlash(SKILL_ID);
      const hunterAfter = await usdc.balanceOf(hunter.address);

      const bounty = (STAKE_AMOUNT * 8000n) / 10000n;
      expect(hunterAfter - hunterBefore).to.equal(bounty);
    });

    it("should reject community slash when disabled (threshold=0)", async function () {
      // Deploy a new registry with threshold=0
      const Registry = await ethers.getContractFactory("SkillBondRegistry");
      const noThresholdRegistry = await Registry.deploy(await usdc.getAddress(), 0);
      await noThresholdRegistry.waitForDeployment();

      await usdc.connect(skillOwner).approve(await noThresholdRegistry.getAddress(), STAKE_AMOUNT);
      const skillId2 = ethers.keccak256(ethers.toUtf8Bytes("test-v2"));
      await noThresholdRegistry.connect(skillOwner).stakeSkill(skillId2, "ipfs://m", STAKE_AMOUNT);
      await noThresholdRegistry.connect(hunter).flagSkill(skillId2);

      await expect(
        noThresholdRegistry.connect(randomUser).communitySlash(skillId2)
      ).to.be.revertedWith("Community slash disabled");
    });
  });

  describe("Trust Tiers", function () {
    it("should return tier 0 for unregistered skill", async function () {
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(0);
    });

    it("should return tier 1 for basic stake (100 USDC)", async function () {
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://m", STAKE_AMOUNT);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(1);
    });

    it("should return tier 2 for verified stake (1000 USDC)", async function () {
      const verifiedStake = 1000n * 10n ** 6n;
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://m", verifiedStake);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(2);
    });

    it("should return tier 3 for premium stake (10000 USDC)", async function () {
      const premiumStake = 10000n * 10n ** 6n;
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://m", premiumStake);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(3);
    });

    it("should return tier 0 for slashed skill", async function () {
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://m", STAKE_AMOUNT);
      await registry.connect(hunter).flagSkill(SKILL_ID);
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      const tier = await registry.getTrustTier(SKILL_ID);
      expect(tier).to.equal(0);
    });

    it("isSkillTrustedAtTier should work correctly", async function () {
      const verifiedStake = 1000n * 10n ** 6n;
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://m", verifiedStake);
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 1)).to.be.true;
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 2)).to.be.true;
      expect(await registry.isSkillTrustedAtTier(SKILL_ID, 3)).to.be.false;
    });
  });

  describe("Withdrawal", function () {
    beforeEach(async function () {
      await registry.connect(skillOwner).stakeSkill(SKILL_ID, "ipfs://metadata", STAKE_AMOUNT);
    });

    it("should reject withdrawal during cooldown", async function () {
      await expect(registry.connect(skillOwner).withdrawStake(SKILL_ID))
        .to.be.revertedWith("Cooldown active");
    });

    it("should allow withdrawal after cooldown", async function () {
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine");
      const balBefore = await usdc.balanceOf(skillOwner.address);
      await registry.connect(skillOwner).withdrawStake(SKILL_ID);
      const balAfter = await usdc.balanceOf(skillOwner.address);
      expect(balAfter - balBefore).to.equal(STAKE_AMOUNT);
    });

    it("should reject withdrawal on slashed skill", async function () {
      await registry.connect(hunter).flagSkill(SKILL_ID);
      await registry.connect(admin).executeSlash(SKILL_ID, hunter.address);
      await expect(registry.connect(skillOwner).withdrawStake(SKILL_ID))
        .to.be.revertedWith("Skill was slashed");
    });
  });

  describe("Admin", function () {
    it("should allow admin to update flag threshold", async function () {
      await expect(registry.connect(admin).setFlagThreshold(5))
        .to.emit(registry, "FlagThresholdUpdated")
        .withArgs(3, 5);
      expect(await registry.flagThreshold()).to.equal(5);
    });

    it("should reject non-admin threshold update", async function () {
      await expect(
        registry.connect(hunter).setFlagThreshold(5)
      ).to.be.revertedWith("Only admin");
    });
  });
});
