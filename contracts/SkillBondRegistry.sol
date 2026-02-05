// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title SkillBondRegistry — Economic Firewall for AI Agent Skills
/// @notice Skills stake USDC to prove confidence. Malicious skills get slashed.
///         Whistleblowers earn 80% of the stake. Security becomes a market.
contract SkillBondRegistry {
    IERC20 public immutable usdc;
    address public admin;

    uint256 public constant MIN_STAKE = 25 * 10**6; // 25 USDC (6 decimals)
    uint256 public constant WHISTLEBLOWER_BPS = 8000; // 80%
    uint256 public constant COOLDOWN_PERIOD = 7 days;

    // Trust tier thresholds
    uint256 public constant TIER_BASIC = 25 * 10**6;       // 25 USDC
    uint256 public constant TIER_STANDARD = 500 * 10**6;    // 500 USDC
    uint256 public constant TIER_PREMIUM = 10000 * 10**6;   // 10,000 USDC

    // Flag threshold for community slashing (decentralized)
    uint256 public flagThreshold;

    struct SkillBond {
        address owner;
        uint256 stakeAmount;
        string metadataURI;    // IPFS hash or URL to skill manifest
        bool isSlashed;
        uint256 stakedAt;
        uint256 flagCount;
        address firstFlagger;  // Tracks who flagged first (gets bounty on community slash)
    }

    mapping(bytes32 => SkillBond) public skills;
    mapping(bytes32 => mapping(address => bool)) public hasFlagged;

    // Insurance fund from burn portions
    uint256 public insuranceFund;

    // Stats
    uint256 public totalSkillsRegistered;
    uint256 public totalSlashed;
    uint256 public totalBountiesPaid;

    event SkillStaked(bytes32 indexed skillId, address indexed owner, uint256 amount, string metadataURI);
    event SkillFlagged(bytes32 indexed skillId, address indexed flagger, uint256 flagCount);
    event SkillSlashed(bytes32 indexed skillId, address indexed whistleblower, uint256 bounty, uint256 burned);
    event SkillWithdrawn(bytes32 indexed skillId, address indexed owner, uint256 amount);
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
            isSlashed: false,
            stakedAt: block.timestamp,
            flagCount: 0,
            firstFlagger: address(0)
        });

        totalSkillsRegistered++;
        emit SkillStaked(_skillId, msg.sender, _amount, _metadataURI);
    }

    /// @notice Flag a skill as potentially malicious. One flag per agent per skill.
    /// @param _skillId The skill to flag
    function flagSkill(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(s.owner != address(0), "Skill not found");
        require(!s.isSlashed, "Already slashed");
        require(!hasFlagged[_skillId][msg.sender], "Already flagged");
        require(msg.sender != s.owner, "Cannot flag own skill");

        hasFlagged[_skillId][msg.sender] = true;
        s.flagCount++;
        if (s.firstFlagger == address(0)) {
            s.firstFlagger = msg.sender;
        }

        emit SkillFlagged(_skillId, msg.sender, s.flagCount);
    }

    /// @notice Execute slash on a flagged skill. Admin verifies proof-of-malice off-chain.
    ///         80% goes to whistleblower, 20% goes to insurance fund.
    /// @param _skillId The skill to slash
    /// @param _whistleblower The agent who discovered the vulnerability
    function executeSlash(bytes32 _skillId, address _whistleblower) external onlyAdmin {
        SkillBond storage s = skills[_skillId];
        require(!s.isSlashed, "Already slashed");
        require(s.stakeAmount > 0, "Nothing to slash");
        require(_whistleblower != address(0), "Invalid whistleblower");

        uint256 total = s.stakeAmount;
        uint256 bounty = (total * WHISTLEBLOWER_BPS) / 10000;
        uint256 burned = total - bounty;

        s.isSlashed = true;
        s.stakeAmount = 0;
        insuranceFund += burned;
        totalSlashed++;
        totalBountiesPaid += bounty;

        require(usdc.transfer(_whistleblower, bounty), "Bounty transfer failed");

        emit SkillSlashed(_skillId, _whistleblower, bounty, burned);
    }

    /// @notice Withdraw stake after cooldown period (only if not slashed)
    /// @param _skillId The skill to withdraw
    function withdrawStake(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(msg.sender == s.owner, "Not skill owner");
        require(!s.isSlashed, "Skill was slashed");
        require(s.stakeAmount > 0, "Nothing to withdraw");
        require(block.timestamp >= s.stakedAt + COOLDOWN_PERIOD, "Cooldown active");

        uint256 amount = s.stakeAmount;
        s.stakeAmount = 0;

        require(usdc.transfer(msg.sender, amount), "Withdraw transfer failed");

        emit SkillWithdrawn(_skillId, msg.sender, amount);
    }

    /// @notice Community slash — anyone can execute once flag threshold is met.
    ///         Bounty goes to the first flagger. No admin needed.
    /// @param _skillId The skill to slash
    function communitySlash(bytes32 _skillId) external {
        require(flagThreshold > 0, "Community slash disabled");
        SkillBond storage s = skills[_skillId];
        require(!s.isSlashed, "Already slashed");
        require(s.stakeAmount > 0, "Nothing to slash");
        require(s.flagCount >= flagThreshold, "Below flag threshold");
        require(s.firstFlagger != address(0), "No flagger recorded");

        uint256 total = s.stakeAmount;
        uint256 bounty = (total * WHISTLEBLOWER_BPS) / 10000;
        uint256 burned = total - bounty;

        s.isSlashed = true;
        s.stakeAmount = 0;
        insuranceFund += burned;
        totalSlashed++;
        totalBountiesPaid += bounty;

        require(usdc.transfer(s.firstFlagger, bounty), "Bounty transfer failed");

        emit SkillSlashed(_skillId, s.firstFlagger, bounty, burned);
    }

    // ---- View Functions ----

    /// @notice Check if a skill is bonded and trusted
    function isSkillTrusted(bytes32 _skillId) external view returns (bool trusted, uint256 stake) {
        SkillBond storage s = skills[_skillId];
        trusted = s.owner != address(0) && !s.isSlashed && s.stakeAmount > 0;
        stake = s.stakeAmount;
    }

    /// @notice Get trust tier for a skill (0=none/revoked, 1=basic, 2=standard, 3=premium)
    ///         Agents can set their own minimum tier to load skills.
    function getTrustTier(bytes32 _skillId) external view returns (uint256 tier) {
        SkillBond storage s = skills[_skillId];
        if (s.owner == address(0) || s.isSlashed || s.stakeAmount == 0) return 0;
        if (s.stakeAmount >= TIER_PREMIUM) return 3;
        if (s.stakeAmount >= TIER_STANDARD) return 2;
        return 1;
    }

    /// @notice Check if skill meets a specific trust tier threshold
    function isSkillTrustedAtTier(bytes32 _skillId, uint256 _minTier) external view returns (bool) {
        SkillBond storage s = skills[_skillId];
        if (s.owner == address(0) || s.isSlashed || s.stakeAmount == 0) return false;
        if (_minTier >= 3) return s.stakeAmount >= TIER_PREMIUM;
        if (_minTier >= 2) return s.stakeAmount >= TIER_STANDARD;
        return true;
    }

    /// @notice Get full skill bond details
    function getSkillBond(bytes32 _skillId) external view returns (
        address owner,
        uint256 stakeAmount,
        string memory metadataURI,
        bool isSlashed,
        uint256 stakedAt,
        uint256 flagCount
    ) {
        SkillBond storage s = skills[_skillId];
        return (s.owner, s.stakeAmount, s.metadataURI, s.isSlashed, s.stakedAt, s.flagCount);
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
