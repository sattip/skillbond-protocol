// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title SkillBondRegistry — Economic Firewall for AI Agent Skills (v2)
/// @notice Skills stake USDC to prove confidence. Malicious skills get slashed.
///         Whistleblowers earn 80% of the stake. Security becomes a market.
///         v2 adds: withdrawal flow, counter-stakes for flagging, time-based tiers.
contract SkillBondRegistry {
    IERC20 public immutable usdc;
    address public admin;

    uint256 public constant MIN_STAKE = 25 * 10**6; // 25 USDC (6 decimals)
    uint256 public constant WHISTLEBLOWER_BPS = 8000; // 80%
    uint256 public constant COOLDOWN_PERIOD = 7 days;
    uint256 public constant COUNTER_STAKE_BPS = 5000; // 50% of target's stake
    uint256 public constant STANDARD_MIN_AGE = 30 days;
    uint256 public constant PREMIUM_MIN_AGE = 90 days;

    // Trust tier thresholds
    uint256 public constant TIER_BASIC = 25 * 10**6;       // 25 USDC
    uint256 public constant TIER_STANDARD = 500 * 10**6;    // 500 USDC
    uint256 public constant TIER_PREMIUM = 10000 * 10**6;   // 10,000 USDC

    // Flag threshold for community slashing (decentralized)
    uint256 public flagThreshold;

    enum SkillStatus { INACTIVE, ACTIVE, WITHDRAWING, SLASHED }

    struct SkillBond {
        address owner;
        uint256 stakeAmount;
        string metadataURI;    // IPFS hash or URL to skill manifest
        SkillStatus status;
        uint256 stakedAt;
        uint256 flagCount;
        address firstFlagger;  // Tracks who flagged first (gets bounty on community slash)
        uint256 withdrawalInitiatedAt;
    }

    mapping(bytes32 => SkillBond) public skills;
    mapping(bytes32 => mapping(address => bool)) public hasFlagged;
    mapping(bytes32 => mapping(address => uint256)) public counterStakes;

    // Insurance fund from burn portions
    uint256 public insuranceFund;

    // Stats
    uint256 public totalSkillsRegistered;
    uint256 public totalSlashed;
    uint256 public totalBountiesPaid;

    event SkillStaked(bytes32 indexed skillId, address indexed owner, uint256 amount, string metadataURI);
    event SkillFlagged(bytes32 indexed skillId, address indexed flagger, uint256 flagCount, uint256 counterStake);
    event SkillSlashed(bytes32 indexed skillId, address indexed whistleblower, uint256 bounty, uint256 burned);
    event SkillWithdrawn(bytes32 indexed skillId, address indexed owner, uint256 amount);
    event SkillWithdrawalInitiated(bytes32 indexed skillId, address indexed owner, uint256 withdrawAt);
    event SkillWithdrawalCancelled(bytes32 indexed skillId, address indexed owner);
    event FlagDismissed(bytes32 indexed skillId, address indexed flagger, uint256 counterStakeSlashed);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event FlagThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor(address _usdc, uint256 _flagThreshold) {
        usdc = IERC20(_usdc);
        admin = msg.sender;
        flagThreshold = _flagThreshold;
    }

    // ---- Core Functions ----

    /// @notice Register a skill by staking USDC. Minimum 25 USDC.
    /// @param _skillId Unique identifier (keccak256 of skill name + version)
    /// @param _metadataURI Link to skill manifest (IPFS, GitHub, etc.)
    /// @param _amount Amount of USDC to stake (6 decimals)
    function stakeSkill(bytes32 _skillId, string calldata _metadataURI, uint256 _amount) external {
        require(_amount >= MIN_STAKE, "Below minimum stake");
        require(skills[_skillId].owner == address(0), "Skill already registered");

        require(usdc.transferFrom(msg.sender, address(this), _amount), "USDC transfer failed");

        skills[_skillId] = SkillBond({
            owner: msg.sender,
            stakeAmount: _amount,
            metadataURI: _metadataURI,
            status: SkillStatus.ACTIVE,
            stakedAt: block.timestamp,
            flagCount: 0,
            firstFlagger: address(0),
            withdrawalInitiatedAt: 0
        });

        totalSkillsRegistered++;
        emit SkillStaked(_skillId, msg.sender, _amount, _metadataURI);
    }

    /// @notice Flag a skill as potentially malicious. Requires 50% counter-stake.
    /// @param _skillId The skill to flag
    function flagSkill(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(s.owner != address(0), "Skill not found");
        require(s.status == SkillStatus.ACTIVE || s.status == SkillStatus.WITHDRAWING, "Skill not active");
        require(!hasFlagged[_skillId][msg.sender], "Already flagged");
        require(msg.sender != s.owner, "Cannot flag own skill");

        uint256 counterStake = (s.stakeAmount * COUNTER_STAKE_BPS) / 10000;
        require(usdc.transferFrom(msg.sender, address(this), counterStake), "Counter-stake transfer failed");

        counterStakes[_skillId][msg.sender] = counterStake;
        hasFlagged[_skillId][msg.sender] = true;
        s.flagCount++;
        if (s.firstFlagger == address(0)) {
            s.firstFlagger = msg.sender;
        }

        emit SkillFlagged(_skillId, msg.sender, s.flagCount, counterStake);
    }

    /// @notice Execute slash on a flagged skill. Admin verifies proof-of-malice off-chain.
    ///         80% goes to whistleblower, 20% goes to insurance fund.
    ///         Whistleblower's counter-stake is also returned.
    /// @param _skillId The skill to slash
    /// @param _whistleblower The agent who discovered the vulnerability
    function executeSlash(bytes32 _skillId, address _whistleblower) external onlyAdmin {
        SkillBond storage s = skills[_skillId];
        require(s.status != SkillStatus.SLASHED, "Already slashed");
        require(s.stakeAmount > 0, "Nothing to slash");
        require(_whistleblower != address(0), "Invalid whistleblower");

        uint256 total = s.stakeAmount;
        uint256 bounty = (total * WHISTLEBLOWER_BPS) / 10000;
        uint256 burned = total - bounty;

        s.status = SkillStatus.SLASHED;
        s.stakeAmount = 0;
        insuranceFund += burned;
        totalSlashed++;
        totalBountiesPaid += bounty;

        // Return whistleblower's counter-stake along with bounty
        uint256 whistleblowerCounterStake = counterStakes[_skillId][_whistleblower];
        uint256 totalPayout = bounty + whistleblowerCounterStake;
        if (whistleblowerCounterStake > 0) {
            counterStakes[_skillId][_whistleblower] = 0;
        }

        require(usdc.transfer(_whistleblower, totalPayout), "Bounty transfer failed");

        emit SkillSlashed(_skillId, _whistleblower, bounty, burned);
    }

    /// @notice Community slash — anyone can execute once flag threshold is met.
    ///         Bounty goes to the first flagger. No admin needed.
    ///         First flagger's counter-stake is also returned.
    /// @param _skillId The skill to slash
    function communitySlash(bytes32 _skillId) external {
        require(flagThreshold > 0, "Community slash disabled");
        SkillBond storage s = skills[_skillId];
        require(s.status != SkillStatus.SLASHED, "Already slashed");
        require(s.stakeAmount > 0, "Nothing to slash");
        require(s.flagCount >= flagThreshold, "Below flag threshold");
        require(s.firstFlagger != address(0), "No flagger recorded");

        uint256 total = s.stakeAmount;
        uint256 bounty = (total * WHISTLEBLOWER_BPS) / 10000;
        uint256 burned = total - bounty;

        address flagger = s.firstFlagger;

        s.status = SkillStatus.SLASHED;
        s.stakeAmount = 0;
        insuranceFund += burned;
        totalSlashed++;
        totalBountiesPaid += bounty;

        // Return first flagger's counter-stake along with bounty
        uint256 flaggerCounterStake = counterStakes[_skillId][flagger];
        uint256 totalPayout = bounty + flaggerCounterStake;
        if (flaggerCounterStake > 0) {
            counterStakes[_skillId][flagger] = 0;
        }

        require(usdc.transfer(flagger, totalPayout), "Bounty transfer failed");

        emit SkillSlashed(_skillId, flagger, bounty, burned);
    }

    // ---- Withdrawal Flow ----

    /// @notice Initiate withdrawal — sets status to WITHDRAWING and starts cooldown.
    /// @param _skillId The skill to start withdrawing
    function initiateWithdrawal(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(msg.sender == s.owner, "Not skill owner");
        require(s.status == SkillStatus.ACTIVE, "Skill not active");

        s.status = SkillStatus.WITHDRAWING;
        s.withdrawalInitiatedAt = block.timestamp;

        emit SkillWithdrawalInitiated(_skillId, msg.sender, block.timestamp);
    }

    /// @notice Complete withdrawal after cooldown period.
    /// @param _skillId The skill to complete withdrawal for
    function completeWithdrawal(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(msg.sender == s.owner, "Not skill owner");
        require(s.status == SkillStatus.WITHDRAWING, "Not in withdrawal");
        require(block.timestamp >= s.withdrawalInitiatedAt + COOLDOWN_PERIOD, "Cooldown active");

        uint256 amount = s.stakeAmount;
        s.stakeAmount = 0;
        s.status = SkillStatus.INACTIVE;
        s.withdrawalInitiatedAt = 0;

        require(usdc.transfer(msg.sender, amount), "Withdraw transfer failed");

        emit SkillWithdrawn(_skillId, msg.sender, amount);
    }

    /// @notice Cancel withdrawal and return to ACTIVE status.
    /// @param _skillId The skill to cancel withdrawal for
    function cancelWithdrawal(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(msg.sender == s.owner, "Not skill owner");
        require(s.status == SkillStatus.WITHDRAWING, "Not in withdrawal");

        s.status = SkillStatus.ACTIVE;
        s.withdrawalInitiatedAt = 0;

        emit SkillWithdrawalCancelled(_skillId, msg.sender);
    }

    // ---- Flag Management ----

    /// @notice Admin dismisses a false flag — flagger's counter-stake goes to insurance fund.
    /// @param _skillId The skill that was falsely flagged
    /// @param _flagger The address of the false flagger
    function dismissFlag(bytes32 _skillId, address _flagger) external onlyAdmin {
        require(hasFlagged[_skillId][_flagger], "Not a flagger");

        uint256 stake = counterStakes[_skillId][_flagger];
        require(stake > 0, "No counter-stake");

        counterStakes[_skillId][_flagger] = 0;
        hasFlagged[_skillId][_flagger] = false;

        SkillBond storage s = skills[_skillId];
        s.flagCount--;
        if (s.firstFlagger == _flagger) {
            s.firstFlagger = address(0);
        }

        insuranceFund += stake;

        emit FlagDismissed(_skillId, _flagger, stake);
    }

    /// @notice Reclaim counter-stake after a skill has been slashed.
    ///         Valid flaggers can get their counter-stake back.
    /// @param _skillId The slashed skill
    function reclaimCounterStake(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(s.status == SkillStatus.SLASHED, "Skill not slashed");

        uint256 stake = counterStakes[_skillId][msg.sender];
        require(stake > 0, "No counter-stake");

        counterStakes[_skillId][msg.sender] = 0;

        require(usdc.transfer(msg.sender, stake), "Counter-stake transfer failed");
    }

    // ---- View Functions ----

    /// @notice Get the current status of a skill
    function getSkillStatus(bytes32 _skillId) external view returns (SkillStatus) {
        return skills[_skillId].status;
    }

    /// @notice Check if a skill is bonded and trusted (only ACTIVE skills are trusted)
    function isSkillTrusted(bytes32 _skillId) external view returns (bool trusted, uint256 stake) {
        SkillBond storage s = skills[_skillId];
        trusted = s.owner != address(0) && s.status == SkillStatus.ACTIVE && s.stakeAmount > 0;
        stake = s.stakeAmount;
    }

    /// @notice Get trust tier for a skill (0=none/revoked, 1=basic, 2=standard, 3=premium)
    ///         Tiers require both stake amount AND minimum age.
    ///         Agents can set their own minimum tier to load skills.
    function getTrustTier(bytes32 _skillId) external view returns (uint256 tier) {
        SkillBond storage s = skills[_skillId];
        if (s.owner == address(0) || s.status != SkillStatus.ACTIVE || s.stakeAmount == 0) return 0;

        uint256 age = block.timestamp - s.stakedAt;

        if (s.stakeAmount >= TIER_PREMIUM && age >= PREMIUM_MIN_AGE) return 3;
        if (s.stakeAmount >= TIER_STANDARD && age >= STANDARD_MIN_AGE) return 2;
        return 1;
    }

    /// @notice Check if skill meets a specific trust tier threshold (with age requirements)
    function isSkillTrustedAtTier(bytes32 _skillId, uint256 _minTier) external view returns (bool) {
        SkillBond storage s = skills[_skillId];
        if (s.owner == address(0) || s.status != SkillStatus.ACTIVE || s.stakeAmount == 0) return false;

        uint256 age = block.timestamp - s.stakedAt;

        if (_minTier >= 3) return s.stakeAmount >= TIER_PREMIUM && age >= PREMIUM_MIN_AGE;
        if (_minTier >= 2) return s.stakeAmount >= TIER_STANDARD && age >= STANDARD_MIN_AGE;
        return true;
    }

    /// @notice Get full skill bond details
    function getSkillBond(bytes32 _skillId) external view returns (
        address owner,
        uint256 stakeAmount,
        string memory metadataURI,
        SkillStatus status,
        uint256 stakedAt,
        uint256 flagCount,
        uint256 withdrawalInitiatedAt
    ) {
        SkillBond storage s = skills[_skillId];
        return (s.owner, s.stakeAmount, s.metadataURI, s.status, s.stakedAt, s.flagCount, s.withdrawalInitiatedAt);
    }

    /// @notice Get protocol stats
    function getStats() external view returns (
        uint256 registered,
        uint256 slashed,
        uint256 bountiesPaid,
        uint256 insurance
    ) {
        return (totalSkillsRegistered, totalSlashed, totalBountiesPaid, insuranceFund);
    }

    // ---- Admin ----

    function transferAdmin(address _newAdmin) external onlyAdmin {
        require(_newAdmin != address(0), "Invalid admin");
        emit AdminTransferred(admin, _newAdmin);
        admin = _newAdmin;
    }

    function setFlagThreshold(uint256 _newThreshold) external onlyAdmin {
        emit FlagThresholdUpdated(flagThreshold, _newThreshold);
        flagThreshold = _newThreshold;
    }
}
