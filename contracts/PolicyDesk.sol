// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FarmLedger} from "./FarmLedger.sol";

/// @title PolicyDesk
/// @notice How a policy comes to exist. Farmers do not book cover themselves:
///   1. Each underwriter appoints insurance agents for one or more districts.
///   2. A registered farmer joins with their district and is assigned to the active agent covering it who has the
///      fewest farmers (the agent's underwriter, or governance, can reassign).
///   3. The agent collects the farmer's details and documents (the application form, kept off-chain) and submits the
///      application here with its hash. The agent can also record the farmer's plots and animals.
///   4. The underwriter reviews it and drafts the contract: final terms (starting from what was asked) and the hash of
///      the contract document. The premium always follows the product's published rate. Or it rejects, with reasons.
///   5. The farmer reviews the offer and accepts it, paying the premium (USSD + Mobile Money, or the portal), within
///      OFFER_PERIOD. Only then is the policy issued (FarmLedger.issuePolicy). The farmer may also decline.
/// The farmer is the policy holder and the only one who can accept; the agent never touches the farmer's money.
contract PolicyDesk {
    enum Status { None, Submitted, Offered, Rejected, Declined, Issued }

    struct Agent {
        address underwriter;   // the insurer that appointed this agent
        bool active;
        uint32 farmers;        // farmers currently assigned
    }

    struct Application {
        address farmer;
        address agent;
        address underwriter;
        uint256 productId;
        uint256 assetId;
        uint256 sumInsured;
        uint64 startAt;        // 0 = when accepted
        uint32 coverDays;
        uint8 level;
        Status status;
        uint64 submittedAt;
        uint64 offerExpires;
        uint256 premium;       // full premium of the drafted contract (before any subsidy)
        uint256 policyId;
        bytes32 formHash;      // hash of the application form + documents the agent submitted
        bytes32 contractHash;  // hash of the contract document the underwriter drafted
        bytes32 reasonHash;    // hash of the written reasons for a rejection
    }

    uint64 public constant OFFER_PERIOD = 14 days;
    uint256 public constant MAX_AGENTS_PER_DISTRICT = 20;
    uint256 public constant MAX_DISTRICTS_PER_AGENT = 10;

    FarmLedger public immutable ledger;

    mapping(address => Agent) private _agents;
    mapping(address => bytes32[]) private _districtsOf;    // agent -> districts covered
    mapping(bytes32 => address[]) private _agentsIn;       // district -> agents
    mapping(address => address) public agentOf;            // farmer -> assigned agent (0 = waiting for one)
    mapping(address => bytes32) public districtOf;         // farmer -> district given when joining

    uint256 public applicationCount;
    mapping(uint256 => Application) private _apps;

    event AgentAppointed(address indexed agent, address indexed underwriter, bytes32[] districts);
    event AgentStatusChanged(address indexed agent, bool active);
    event FarmerJoined(address indexed farmer, bytes32 indexed district);
    event FarmerAssigned(address indexed farmer, address indexed agent, address indexed by);
    event ApplicationSubmitted(uint256 indexed applicationId, address indexed farmer, address indexed agent, uint256 productId, uint256 assetId, uint256 sumInsured, bytes32 formHash);
    event ContractDrafted(uint256 indexed applicationId, address indexed farmer, address indexed agent, uint256 premium, uint64 offerExpires, bytes32 contractHash);
    event ApplicationRejected(uint256 indexed applicationId, address indexed farmer, address indexed agent, bytes32 reasonHash);
    event OfferDeclined(uint256 indexed applicationId, address indexed farmer);
    event PolicyIssuedFromApplication(uint256 indexed applicationId, uint256 indexed policyId, address indexed farmer);

    error NotUnderwriter();
    error NotAgent();
    error NotYourAgent();
    error NotYourFarmer();
    error AlreadyAgent();
    error AlreadyJoined();
    error NotRegistered();
    error WrongUnderwriter();
    error NotFarmerOfApplication();
    error BadStatus();
    error OfferExpired();
    error TooMany();
    error InvalidInput();

    constructor(FarmLedger ledger_) {
        if (address(ledger_) == address(0)) revert InvalidInput();
        ledger = ledger_;
    }

    // ---------------------------------------------------------------- agents (appointed by an underwriter)

    modifier onlyUnderwriter() {
        if (!ledger.hasRole(ledger.UNDERWRITER_ROLE(), msg.sender)) revert NotUnderwriter();
        _;
    }

    function appointAgent(address agent, bytes32[] calldata districts) external onlyUnderwriter {
        if (agent == address(0) || agent == msg.sender || districts.length == 0 || districts.length > MAX_DISTRICTS_PER_AGENT) revert InvalidInput();
        if (_agents[agent].underwriter != address(0)) revert AlreadyAgent();
        _agents[agent] = Agent({underwriter: msg.sender, active: true, farmers: 0});
        for (uint256 i = 0; i < districts.length; i++) {
            if (districts[i] == bytes32(0)) revert InvalidInput();
            if (_agentsIn[districts[i]].length >= MAX_AGENTS_PER_DISTRICT) revert TooMany();
            _agentsIn[districts[i]].push(agent);
            _districtsOf[agent].push(districts[i]);
        }
        emit AgentAppointed(agent, msg.sender, districts);
    }

    /// @notice Suspend or reinstate an agent. A suspended agent gets no new farmers and cannot submit applications;
    ///         their farmers should be reassigned.
    function setAgentActive(address agent, bool active) external {
        if (_agents[agent].underwriter != msg.sender) revert NotYourAgent();
        _agents[agent].active = active;
        emit AgentStatusChanged(agent, active);
    }

    // ---------------------------------------------------------------- farmers and assignment

    /// @notice Called by a registered farmer (web, or the phone-account service right after registration) with the
    ///         district the farm is in. Assigns the active agent covering it who has the fewest farmers; if none covers
    ///         it yet the farmer waits, and may call join again later.
    function join(bytes32 district) external {
        if (!ledger.getFarmer(msg.sender).exists) revert NotRegistered();
        if (agentOf[msg.sender] != address(0)) revert AlreadyJoined();
        if (district == bytes32(0)) revert InvalidInput();
        districtOf[msg.sender] = district;
        emit FarmerJoined(msg.sender, district);
        address best;
        uint32 fewest = type(uint32).max;
        address[] storage list = _agentsIn[district];
        for (uint256 i = 0; i < list.length; i++) {
            Agent storage a = _agents[list[i]];
            if (a.active && a.farmers < fewest) { best = list[i]; fewest = a.farmers; }
        }
        if (best != address(0)) _assign(msg.sender, best);
    }

    /// @notice Move a farmer to another agent: by the underwriter of the farmer's current agent (to one of its own
    ///         agents), by any underwriter for a farmer still waiting, or by governance.
    function reassign(address farmer, address agent) external {
        if (!ledger.getFarmer(farmer).exists) revert NotRegistered();
        Agent storage to = _agents[agent];
        if (to.underwriter == address(0) || !to.active) revert NotAgent();
        bool governance = ledger.hasRole(ledger.DEFAULT_ADMIN_ROLE(), msg.sender);
        if (!governance) {
            if (to.underwriter != msg.sender) revert NotYourAgent();
            address current = agentOf[farmer];
            if (current != address(0) && _agents[current].underwriter != msg.sender) revert NotYourFarmer();
        }
        _assign(farmer, agent);
    }

    function _assign(address farmer, address agent) private {
        address current = agentOf[farmer];
        if (current != address(0)) _agents[current].farmers -= 1;
        agentOf[farmer] = agent;
        _agents[agent].farmers += 1;
        emit FarmerAssigned(farmer, agent, msg.sender);
    }

    modifier onlyAgentOf(address farmer) {
        Agent storage a = _agents[msg.sender];
        if (a.underwriter == address(0) || !a.active) revert NotAgent();
        if (agentOf[farmer] != msg.sender) revert NotYourFarmer();
        _;
    }

    // ---------------------------------------------------------------- assets recorded by the agent

    function registerPlotFor(address farmer, int32 latE6, int32 lonE6, uint32 areaM2, bytes32 crop, bytes32 geoHash)
        external onlyAgentOf(farmer) returns (uint256)
    {
        return ledger.registerPlotFor(farmer, latE6, lonE6, areaM2, crop, geoHash);
    }

    function registerAnimalFor(address farmer, bytes32 tagId, bytes32 breed, uint16 birthYear, bytes32 photoHash)
        external onlyAgentOf(farmer) returns (uint256)
    {
        return ledger.registerAnimalFor(farmer, tagId, breed, birthYear, photoHash);
    }

    // ---------------------------------------------------------------- applications

    function submitApplication(
        address farmer,
        uint256 productId,
        uint256 assetId,
        uint256 sumInsured,
        uint8 level,
        uint64 startAt,
        uint32 coverDays,
        bytes32 formHash
    ) external onlyAgentOf(farmer) returns (uint256 id) {
        FarmLedger.Product memory p = ledger.getProduct(productId);
        if (p.underwriter != _agents[msg.sender].underwriter) revert WrongUnderwriter(); // tied agent: own insurer only
        if (!p.active) revert BadStatus();
        if (sumInsured == 0 || formHash == bytes32(0)) revert InvalidInput();
        ledger.quoteCover(productId, level, sumInsured, coverDays); // reverts on an unknown level or cover length
        id = ++applicationCount;
        Application storage a = _apps[id];
        a.farmer = farmer;
        a.agent = msg.sender;
        a.underwriter = p.underwriter;
        a.productId = productId;
        a.assetId = assetId;
        a.sumInsured = sumInsured;
        a.level = level;
        a.startAt = startAt;
        a.coverDays = coverDays;
        a.formHash = formHash;
        a.status = Status.Submitted;
        a.submittedAt = uint64(block.timestamp);
        emit ApplicationSubmitted(id, farmer, msg.sender, productId, assetId, sumInsured, formHash);
    }

    /// @notice The underwriter drafts (or re-drafts, until accepted) the contract. Terms may differ from what was asked;
    ///         the premium is computed from the product rate for those terms.
    function draftContract(uint256 id, uint8 level, uint256 sumInsured, uint64 startAt, uint32 coverDays, bytes32 contractHash) external {
        Application storage a = _apps[id];
        if (a.underwriter != msg.sender || !ledger.hasRole(ledger.UNDERWRITER_ROLE(), msg.sender)) revert NotUnderwriter();
        if (a.status != Status.Submitted && a.status != Status.Offered) revert BadStatus();
        if (sumInsured == 0 || contractHash == bytes32(0)) revert InvalidInput();
        a.premium = ledger.quoteCover(a.productId, level, sumInsured, coverDays);
        a.level = level;
        a.sumInsured = sumInsured;
        a.startAt = startAt;
        a.coverDays = coverDays;
        a.contractHash = contractHash;
        a.offerExpires = uint64(block.timestamp) + OFFER_PERIOD;
        a.status = Status.Offered;
        emit ContractDrafted(id, a.farmer, a.agent, a.premium, a.offerExpires, contractHash);
    }

    function rejectApplication(uint256 id, bytes32 reasonHash) external {
        Application storage a = _apps[id];
        if (a.underwriter != msg.sender) revert NotUnderwriter();
        if (a.status != Status.Submitted && a.status != Status.Offered) revert BadStatus();
        if (reasonHash == bytes32(0)) revert InvalidInput();
        a.status = Status.Rejected;
        a.reasonHash = reasonHash;
        emit ApplicationRejected(id, a.farmer, a.agent, reasonHash);
    }

    /// @notice The farmer accepts the drafted contract. They must have approved FarmLedger for the premium (minus any
    ///         subsidy); the phone-account service does approve + accept in one operation after Mobile Money paid.
    function acceptOffer(uint256 id) external returns (uint256 policyId) {
        Application storage a = _apps[id];
        if (a.farmer != msg.sender) revert NotFarmerOfApplication();
        if (a.status != Status.Offered) revert BadStatus();
        if (block.timestamp > a.offerExpires) revert OfferExpired();
        a.status = Status.Issued;
        policyId = ledger.issuePolicy(a.farmer, a.productId, a.assetId, a.sumInsured, a.level, a.startAt, a.coverDays, a.contractHash);
        a.policyId = policyId;
        emit PolicyIssuedFromApplication(id, policyId, a.farmer);
    }

    function declineOffer(uint256 id) external {
        Application storage a = _apps[id];
        if (a.farmer != msg.sender) revert NotFarmerOfApplication();
        if (a.status != Status.Offered) revert BadStatus();
        a.status = Status.Declined;
        emit OfferDeclined(id, a.farmer);
    }

    // ---------------------------------------------------------------- views

    function getApplication(uint256 id) external view returns (Application memory) { return _apps[id]; }
    function getAgent(address agent) external view returns (Agent memory) { return _agents[agent]; }
    function districtsOfAgent(address agent) external view returns (bytes32[] memory) { return _districtsOf[agent]; }
    function agentsIn(bytes32 district) external view returns (address[] memory) { return _agentsIn[district]; }
    function isAgent(address who) external view returns (bool) { return _agents[who].underwriter != address(0) && _agents[who].active; }
}
