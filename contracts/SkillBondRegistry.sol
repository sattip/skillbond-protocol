// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title SkillBondRegistry — Economic Firewall for AI Agent Skills (v4)
/// @notice Skills stake USDC to prove confidence. Malicious skills get slashed.
///         Whistleblowers earn 80% of the stake. Security becomes a market.
///         v2 adds: withdrawal flow, counter-stakes for flagging, time-based tiers.
///         v3 adds: evidence hashes on flags, usage fees (x402-style), sponsorship bonds.
///         v4 adds: emergency pause, bulk queries, batch reads, input validation.
contract SkillBondRegistry {
    IERC20 public immutable usdc;
    address public admin;

    // v4: Emergency pause
    bool public paused;

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

    // v3: Usage fee constants
    uint256 public constant QUERY_FEE = 50000; // 0.05 USDC (6 decimals)
    uint256 public constant SKILL_OWNER_FEE_BPS = 7000; // 70%

    // v4: Minimum sponsor amount (1 USDC)
    uint256 public constant MIN_SPONSOR = 1 * 10**6; // 1 USDC (6 decimals)

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

    // v3: Evidence hash mapping for flags
    mapping(bytes32 => mapping(address => bytes32)) public flagEvidence;

    // v3: Usage fee state
    uint256 public totalFeesCollected;
    mapping(bytes32 => uint256) public queryCount;
    mapping(bytes32 => uint256) public skillFeesEarned;

    // v3: Sponsorship state
    mapping(bytes32 => mapping(address => uint256)) public sponsorStakes;
    mapping(bytes32 => mapping(address => uint256)) public sponsoredAt;

    event SkillStaked(bytes32 indexed skillId, address indexed owner, uint256 amount, string metadataURI);
    event SkillFlagged(bytes32 indexed skillId, address indexed flagger, uint256 flagCount, uint256 counterStake, bytes32 evidenceHash);
    event SkillSlashed(bytes32 indexed skillId, address indexed whistleblower, uint256 bounty, uint256 burned);
    event SkillWithdrawn(bytes32 indexed skillId, address indexed owner, uint256 amount);
    event SkillWithdrawalInitiated(bytes32 indexed skillId, address indexed owner, uint256 withdrawAt);
    event SkillWithdrawalCancelled(bytes32 indexed skillId, address indexed owner);
    event FlagDismissed(bytes32 indexed skillId, address indexed flagger, uint256 counterStakeSlashed);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event FlagThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    // v3: New events
    event TrustQueried(bytes32 indexed skillId, address indexed querier, uint256 fee);
    event FeesClaimedByOwner(bytes32 indexed skillId, address indexed owner, uint256 amount);
    event SkillSponsored(bytes32 indexed skillId, address indexed sponsor, uint256 amount, uint256 newTotalStake);
    event SponsorshipWithdrawn(bytes32 indexed skillId, address indexed sponsor, uint256 amount);

    // v4: Pause events
    event ProtocolPaused(address admin);
    event ProtocolUnpaused(address admin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Protocol is paused");
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
    function stakeSkill(bytes32 _skillId, string calldata _metadataURI, uint256 _amount) external whenNotPaused {
        require(_amount >= MIN_STAKE, "Below minimum stake");
        require(bytes(_metadataURI).length > 0, "Metadata URI required");
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
    /// @param _evidenceHash On-chain proof hash of what the flagger observed
    function flagSkill(bytes32 _skillId, bytes32 _evidenceHash) external whenNotPaused {
        SkillBond storage s = skills[_skillId];
        require(s.owner != address(0), "Skill not found");
        require(s.status == SkillStatus.ACTIVE || s.status == SkillStatus.WITHDRAWING, "Skill not active");
        require(!hasFlagged[_skillId][msg.sender], "Already flagged");
        require(msg.sender != s.owner, "Cannot flag own skill");

        uint256 counterStake = (s.stakeAmount * COUNTER_STAKE_BPS) / 10000;
        require(usdc.transferFrom(msg.sender, address(this), counterStake), "Counter-stake transfer failed");

        counterStakes[_skillId][msg.sender] = counterStake;
        hasFlagged[_skillId][msg.sender] = true;
        flagEvidence[_skillId][msg.sender] = _evidenceHash;
        s.flagCount++;
        if (s.firstFlagger == address(0)) {
            s.firstFlagger = msg.sender;
        }

        emit SkillFlagged(_skillId, msg.sender, s.flagCount, counterStake, _evidenceHash);
    }

    /// @notice Execute slash on a flagged skill. Admin verifies proof-of-malice off-chain.
    ///         80% goes to whistleblower, 20% goes to insurance fund.
    ///         Whistleblower's counter-stake is also returned.
    /// @param _skillId The skill to slash
    /// @param _whistleblower The agent who discovered the vulnerability
    function executeSlash(bytes32 _skillId, address _whistleblower) external onlyAdmin whenNotPaused {
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
    function communitySlash(bytes32 _skillId) external whenNotPaused {
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

    // ---- v3: Usage Fee / Query Payment ----

    /// @notice Paid trust query (x402-style). Charges 0.05 USDC, splits 70/30 owner/protocol.
    /// @param _skillId The skill to query trust info for
    /// @return tier The trust tier (0-3)
    /// @return status The skill status
    /// @return stake The current stake amount
    /// @return age The time since the skill was staked
    function queryTrust(bytes32 _skillId) external returns (uint256 tier, SkillStatus status, uint256 stake, uint256 age) {
        SkillBond storage s = skills[_skillId];
        require(s.owner != address(0), "Skill not found");

        // v4: Don't charge fee for SLASHED or INACTIVE skills — return early with tier 0
        if (s.status == SkillStatus.SLASHED || s.status == SkillStatus.INACTIVE) {
            return (0, s.status, s.stakeAmount, block.timestamp - s.stakedAt);
        }

        require(usdc.transferFrom(msg.sender, address(this), QUERY_FEE), "Fee transfer failed");

        uint256 ownerShare = (QUERY_FEE * SKILL_OWNER_FEE_BPS) / 10000;
        uint256 protocolShare = QUERY_FEE - ownerShare;

        skillFeesEarned[_skillId] += ownerShare;
        insuranceFund += protocolShare;
        totalFeesCollected += QUERY_FEE;
        queryCount[_skillId]++;

        // Compute trust tier
        status = s.status;
        stake = s.stakeAmount;
        age = block.timestamp - s.stakedAt;

        if (s.stakeAmount == 0) {
            tier = 0;
        } else if (s.stakeAmount >= TIER_PREMIUM && age >= PREMIUM_MIN_AGE) {
            tier = 3;
        } else if (s.stakeAmount >= TIER_STANDARD && age >= STANDARD_MIN_AGE) {
            tier = 2;
        } else {
            tier = 1;
        }

        emit TrustQueried(_skillId, msg.sender, QUERY_FEE);
    }

    /// @notice Skill owner claims accumulated query fees.
    /// @param _skillId The skill to claim fees for
    function claimFees(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(msg.sender == s.owner, "Not skill owner");

        uint256 amount = skillFeesEarned[_skillId];
        require(amount > 0, "No fees to claim");

        skillFeesEarned[_skillId] = 0;

        require(usdc.transfer(msg.sender, amount), "Fee transfer failed");

        emit FeesClaimedByOwner(_skillId, msg.sender, amount);
    }

    // ---- v3: Sponsorship Bonds ----

    /// @notice Sponsor a skill by adding additional USDC stake. Increases tier potential.
    /// @param _skillId The skill to sponsor
    /// @param _amount Amount of USDC to sponsor (6 decimals)
    function sponsorSkill(bytes32 _skillId, uint256 _amount) external whenNotPaused {
        require(_amount >= MIN_SPONSOR, "Below minimum sponsor amount");
        SkillBond storage s = skills[_skillId];
        require(s.owner != address(0), "Skill not found");
        require(s.status == SkillStatus.ACTIVE, "Skill not active");

        require(usdc.transferFrom(msg.sender, address(this), _amount), "Sponsor transfer failed");

        s.stakeAmount += _amount;
        sponsorStakes[_skillId][msg.sender] += _amount;
        sponsoredAt[_skillId][msg.sender] = block.timestamp;

        emit SkillSponsored(_skillId, msg.sender, _amount, s.stakeAmount);
    }

    /// @notice Withdraw sponsorship stake. Requires ACTIVE skill and cooldown.
    /// @param _skillId The skill to withdraw sponsorship from
    function withdrawSponsorship(bytes32 _skillId) external {
        SkillBond storage s = skills[_skillId];
        require(s.status == SkillStatus.ACTIVE, "Skill not active");

        uint256 amount = sponsorStakes[_skillId][msg.sender];
        require(amount > 0, "No sponsorship stake");
        require(block.timestamp >= sponsoredAt[_skillId][msg.sender] + COOLDOWN_PERIOD, "Cooldown active");

        sponsorStakes[_skillId][msg.sender] = 0;
        s.stakeAmount -= amount;

        require(usdc.transfer(msg.sender, amount), "Sponsorship withdrawal failed");

        emit SponsorshipWithdrawn(_skillId, msg.sender, amount);
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

    // ---- v4: Bulk Query Functions ----

    /// @notice Batch query trust info for multiple skills in a single call.
    ///         Returns arrays of (tier, stake, status) for each skill ID.
    /// @param _skillIds Array of skill IDs to query
    /// @return tiers Array of trust tiers (0-3)
    /// @return stakes Array of stake amounts
    /// @return statuses Array of skill statuses
    function batchQueryTrust(bytes32[] calldata _skillIds) external view returns (
        uint256[] memory tiers,
        uint256[] memory stakes,
        SkillStatus[] memory statuses
    ) {
        uint256 len = _skillIds.length;
        tiers = new uint256[](len);
        stakes = new uint256[](len);
        statuses = new SkillStatus[](len);

        for (uint256 i = 0; i < len; i++) {
            SkillBond storage s = skills[_skillIds[i]];
            statuses[i] = s.status;
            stakes[i] = s.stakeAmount;

            if (s.owner == address(0) || s.status != SkillStatus.ACTIVE || s.stakeAmount == 0) {
                tiers[i] = 0;
            } else {
                uint256 age = block.timestamp - s.stakedAt;
                if (s.stakeAmount >= TIER_PREMIUM && age >= PREMIUM_MIN_AGE) {
                    tiers[i] = 3;
                } else if (s.stakeAmount >= TIER_STANDARD && age >= STANDARD_MIN_AGE) {
                    tiers[i] = 2;
                } else {
                    tiers[i] = 1;
                }
            }
        }
    }

    /// @notice Batch read full skill bond details for multiple skills.
    /// @param _skillIds Array of skill IDs to read
    /// @return bonds Array of SkillBond structs
    function getSkillBonds(bytes32[] calldata _skillIds) external view returns (SkillBond[] memory bonds) {
        uint256 len = _skillIds.length;
        bonds = new SkillBond[](len);
        for (uint256 i = 0; i < len; i++) {
            bonds[i] = skills[_skillIds[i]];
        }
    }

    // ---- v4: Emergency Pause ----

    /// @notice Pause the protocol. Disables staking, flagging, slashing, and sponsoring.
    function pause() external onlyAdmin {
        require(!paused, "Already paused");
        paused = true;
        emit ProtocolPaused(msg.sender);
    }

    /// @notice Unpause the protocol. Re-enables all operations.
    function unpause() external onlyAdmin {
        require(paused, "Not paused");
        paused = false;
        emit ProtocolUnpaused(msg.sender);
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
