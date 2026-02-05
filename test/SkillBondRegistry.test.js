const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SkillBondRegistry", function () {
  let registry, usdc;
  let admin, skillOwner, hunter, randomUser;
  const STAKE_AMOUNT = 100n * 10n ** 6n;
  const SKILL_ID = ethers.keccak256(ethers.toUtf8Bytes("test-skill-v1.0"));

  beforeEach(async function () {
    [admin, skillOwner, hunter, randomUser] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockUSDC");
    usdc = await MockERC20.deploy();
    await usdc.waitForDeployment();

    const Registry = await ethers.getContractFactory("SkillBondRegistry");
    registry = await Registry.deploy(await usdc.getAddress());
    await registry.waitForDeployment();

    await usdc.mint(skillOwner.address, 1000n * 10n ** 6n);
    await usdc.connect(skillOwner).approve(await registry.getAddress(), STAKE_AMOUNT);
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
      await usdc.connect(skillOwner).approve(await registry.getAddress(), STAKE_AMOUNT);
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
  });

  describe("Slashing (The Execution)", function () {
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
});
