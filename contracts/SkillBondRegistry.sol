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

    uint256 public constant MIN_STAKE = 100 * 10**6; // 100 USDC (6 decimals)
    uint256 public constant WHISTLEBLOWER_BPS = 8000; // 80%
    uint256 public constant COOLDOWN_PERIOD = 7 days;

    struct SkillBond {
        address owner;
        uint256 stakeAmount;
        string metadataURI;    // IPFS hash or URL to skill manifest
        bool isSlashed;
        uint256 stakedAt;
        uint256 flagCount;
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

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        admin = msg.sender;
    }

    /// @notice Register a skill by staking USDC. Minimum 100 USDC.
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
            flagCount: 0
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

    // ---- View Functions ----

    /// @notice Check if a skill is bonded and trusted
    function isSkillTrusted(bytes32 _skillId) external view returns (bool trusted, uint256 stake) {
        SkillBond storage s = skills[_skillId];
        trusted = s.owner != address(0) && !s.isSlashed && s.stakeAmount > 0;
        stake = s.stakeAmount;
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
}
