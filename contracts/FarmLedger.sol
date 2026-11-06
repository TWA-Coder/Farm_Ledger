// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FarmLedger
/// @notice Dual-mode parametric micro-insurance for smallholder crops and livestock.
///   Mode 1 (crop / pasture): an authorised oracle posts rainfall or NDVI readings for a registered plot;
///           the contract compares them with the product threshold and pays out automatically.
///   Mode 2 (livestock): the farmer files a claim; certified veterinarians each sign an EIP-712 attestation.
///           The contract verifies every signature on-chain and pays only when a quorum (M distinct, currently
///           certified vets, none of them the claimant) agree. The quorum is fixed per claim when it is filed.
/// Premiums and underwriter liquidity sit in an escrow pool; every policy reserves its full sum insured,
/// so a payout can never fail for lack of funds.
contract FarmLedger is AccessControl, EIP712, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- roles
    // DEFAULT_ADMIN_ROLE = System Administrator / governance
    bytes32 public constant UNDERWRITER_ROLE = keccak256("UNDERWRITER_ROLE");
    bytes32 public constant VET_ROLE = keccak256("VET_ROLE");
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    // The USSD gateway. It can ONLY register a claim on behalf of a policy holder; it cannot book, price,
    // activate or change a policy, move money, or sign for a vet.
    bytes32 public constant CLAIMS_AGENT_ROLE = keccak256("CLAIMS_AGENT_ROLE");
    // The government premium-subsidy programme (e.g. Rwanda NAIS, 40%): funds the subsidy pool and sets its rules.
    bytes32 public constant SUBSIDY_ROLE = keccak256("SUBSIDY_ROLE");
    // The CropClaims contract: may hold a crop policy open while a loss claim is reviewed, and pay the amount its
    // reviewers agreed. Granted to that contract only, never to a person.
    bytes32 public constant ASSESSOR_ROLE = keccak256("ASSESSOR_ROLE");
    // The PolicyDesk contract: issues a policy once the underwriter drafted it and the farmer accepted and paid, and
    // registers plots and animals that an insurance agent recorded for one of their farmers. Contract only.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    // Veterinary registrar (e.g. the professional council): certifies and revokes vets. Separate from governance.
    bytes32 public constant VET_REGISTRAR_ROLE = keccak256("VET_REGISTRAR_ROLE");
    // Guardian: may pause at once in an emergency. Unpausing stays with governance (DEFAULT_ADMIN_ROLE).
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(uint256 claimId,uint256 policyId,bytes32 tagId,bool approved,uint256 deadline)");

    uint16 public constant BPS = 10_000;
    uint64 public constant MAX_WAITING_PERIOD = 30 days;
    uint256 public constant MAX_POLICIES_PER_PLOT = 25;
    uint64 public constant MAX_START_DELAY = 90 days;   // cover may start up to this far in the future, never in the past
    uint32 public constant MIN_COVER_DAYS = 30;         // shortest cover a farmer can choose (or the product length if shorter)
    uint256 public constant MAX_TRIGGER_LEVELS = 5;

    // ---------------------------------------------------------------- types
    enum Cover { Drought, Flood, LowNDVI, Livestock }
    enum Metric { Rainfall, NDVI }
    enum PolicyStatus { Active, ClaimPending, PaidOut, Expired }
    enum ClaimStatus { None, Pending, Approved, Rejected }

    struct Farmer {
        bytes32 idHash;      // keccak256 of National ID (+ salt) - no personal data on-chain
        bytes32 phoneHash;   // keccak256 of phone number, used by the notifier to find the MoMo wallet
        uint64 registeredAt;
        bool exists;
    }

    struct Plot {
        address owner;
        int32 latE6;         // latitude  x 1e6
        int32 lonE6;         // longitude x 1e6
        uint32 areaM2;
        bytes32 crop;        // e.g. "MAIZE"
        bytes32 geoHash;     // hash / CID of the boundary GeoJSON (IPFS in production)
        bool exists;
    }

    struct Animal {
        address owner;
        bytes32 tagId;       // RFID ear tag
        bytes32 breed;
        uint16 birthYear;
        bytes32 photoHash;
        bool deceased;
        bool exists;
    }

    struct Product {
        address underwriter;
        Cover cover;
        int256 threshold;    // Drought/LowNDVI pay when reading < threshold; Flood pays when reading > threshold
        uint16 rateBps;      // premium = sumInsured * rateBps / 10000
        uint32 durationDays;
        bool active;
    }

    struct Policy {
        address holder;
        uint256 productId;
        uint256 assetId;     // plotId for crop covers, animalId for livestock
        uint256 sumInsured;
        uint256 premium;
        uint64 start;
        uint64 end;
        PolicyStatus status;
        uint8 level;         // index into the product's trigger levels chosen at purchase
        int256 threshold;    // trigger copied from that level, so later product changes never alter this policy
    }

    /// @dev One selectable trigger for a weather product, with its own price. Level 0 is set by createProduct.
    struct TriggerLevel {
        int256 threshold;
        uint16 rateBps;
    }

    struct Claim {
        uint256 policyId;
        bytes32 evidenceHash; // hash / CID of the timestamped photo
        uint64 filedAt;
        ClaimStatus status;
        uint8 quorum;         // vet attestations needed, fixed when the claim is filed
        uint8 approvals;
        uint8 rejections;
    }

    /// @dev Professional certification of a sector veterinarian. Role membership alone is not enough:
    ///      the licence record must be active and unexpired for a signature to count.
    struct VetProfile {
        bytes32 licenseHash;  // hash of the licence number issued by the regulator
        bytes32 sector;       // administrative sector served, e.g. "BUGESERA"
        uint64 certifiedAt;
        uint64 validUntil;
        bool active;
    }

    struct Reading {
        int256 value;
        uint64 observedAt;
        uint64 postedAt;
    }

    struct Stats {
        uint256 premiums;
        uint256 paidOut;
        uint32 policiesSold;
        uint32 payouts;
    }

    /// @dev Premium subsidy rules. Paid from `subsidyPool` (funded by the programme) to the underwriter together with
    ///      the farmer's share, so the underwriter always receives the full premium.
    struct SubsidyConfig {
        uint16 rateBps;          // share of the premium paid by the programme, e.g. 4000 = 40%
        uint256 capPerFarmer;    // most one farmer can receive in total; 0 = no cap
    }

    // ---------------------------------------------------------------- storage
    IERC20 public immutable token;
    uint64 public waitingPeriod = 7 days; // livestock claims only after this period (moral-hazard guard)

    mapping(address => Farmer) private _farmers;
    mapping(bytes32 => bool) private _idUsed;

    uint256 public plotCount;
    uint256 public animalCount;
    uint256 public productCount;
    uint256 public policyCount;
    uint256 public claimCount;

    mapping(uint256 => Plot) private _plots;
    mapping(uint256 => Animal) private _animals;
    mapping(bytes32 => uint256) private _animalByTag;
    mapping(uint256 => bool) private _animalCovered;
    mapping(uint256 => Product) private _products;
    mapping(uint256 => Policy) private _policies;
    mapping(uint256 => Claim) private _claims;

    mapping(address => uint256[]) private _plotsOf;
    mapping(address => uint256[]) private _animalsOf;
    mapping(address => uint256[]) private _policiesOf;
    mapping(uint256 => uint256[]) private _activePolicesOfPlot;

    mapping(uint256 => mapping(Metric => Reading)) private _latestReading;

    uint8 public constant MAX_QUORUM = 5;
    uint8 public vetQuorum = 1;                        // attestations required for NEW claims
    mapping(address => VetProfile) private _vetProfiles;
    address[] private _vetList;
    mapping(uint256 => mapping(address => bool)) private _attested;

    mapping(uint256 => TriggerLevel[]) private _levels; // productId -> selectable triggers (weather products)
    mapping(uint256 => bytes32) private _applicationHash; // policyId -> hash of the booking application (data + documents)

    mapping(address => uint256) public poolBalance;   // underwriter => funds (liquidity + premiums - payouts)
    mapping(address => uint256) public poolReserved;  // underwriter => sum insured of open policies
    mapping(address => Stats) private _stats;

    uint16 public constant MAX_SUBSIDY_BPS = 9000;
    SubsidyConfig public subsidyConfig;
    uint256 public subsidyPool;                          // programme funds not yet used
    uint256 public subsidyPaid;                          // total paid towards premiums
    mapping(address => uint256) public subsidyUsed;      // farmer => subsidy received so far
    mapping(uint256 => bool) public subsidyEligible;     // productId => covered by the programme
    mapping(uint256 => uint256) public subsidyOf;        // policyId => subsidy paid for it

    mapping(uint256 => bool) public underAssessment;     // policyId => a crop loss claim is being reviewed

    // ---------------------------------------------------------------- events
    event FarmerRegistered(address indexed farmer, bytes32 idHash, bytes32 phoneHash);
    event PlotRegistered(uint256 indexed plotId, address indexed owner, int32 latE6, int32 lonE6, uint32 areaM2, bytes32 crop, bytes32 geoHash);
    event AnimalRegistered(uint256 indexed animalId, address indexed owner, bytes32 tagId, bytes32 breed, uint16 birthYear, bytes32 photoHash);
    event ProductCreated(uint256 indexed productId, address indexed underwriter, Cover cover, int256 threshold, uint16 rateBps, uint32 durationDays);
    event ProductStatusChanged(uint256 indexed productId, bool active);
    event LiquidityDeposited(address indexed underwriter, uint256 amount);
    event LiquidityWithdrawn(address indexed underwriter, uint256 amount);
    event TriggerLevelAdded(uint256 indexed productId, uint8 level, int256 threshold, uint16 rateBps);
    event PolicyTerms(uint256 indexed policyId, uint8 level, int256 threshold, uint32 coverDays);
    event PolicyPurchased(uint256 indexed policyId, address indexed holder, uint256 indexed productId, uint256 assetId, uint256 sumInsured, uint256 premium, uint64 start, uint64 end);
    event ReadingPosted(uint256 indexed plotId, Metric indexed metric, int256 value, uint64 observedAt);
    event ClaimFiled(uint256 indexed claimId, uint256 indexed policyId, address indexed holder, bytes32 tagId, bytes32 evidenceHash);
    event ClaimChannel(uint256 indexed claimId, address indexed filedBy, bool viaAgent);
    event ApplicationRecorded(uint256 indexed policyId, address indexed holder, bytes32 applicationHash);
    event VetCertified(address indexed vet, bytes32 licenseHash, bytes32 sector, uint64 validUntil);
    event VetRevoked(address indexed vet);
    event VetQuorumChanged(uint8 quorum);
    event ClaimAttested(uint256 indexed claimId, address indexed vet, bool approved, uint8 approvals, uint8 rejections);
    event ClaimSettled(uint256 indexed claimId, uint256 indexed policyId, bool approved, address attestedBy);
    event PayoutExecuted(uint256 indexed policyId, address indexed holder, uint256 amount, Cover cover, bool automatic);
    event PolicyExpired(uint256 indexed policyId);
    event WaitingPeriodChanged(uint64 waitingPeriod);
    event FarmerPhoneChanged(address indexed farmer, bytes32 phoneHash);
    event SubsidyFunded(address indexed by, uint256 amount);
    event SubsidyWithdrawn(address indexed by, uint256 amount);
    event SubsidyConfigured(uint16 rateBps, uint256 capPerFarmer);
    event SubsidyEligibility(uint256 indexed productId, bool eligible);
    event PremiumSubsidised(uint256 indexed policyId, address indexed holder, uint256 subsidy, uint256 farmerPaid);
    event AssessmentHold(uint256 indexed policyId, bool held);

    // ---------------------------------------------------------------- errors
    error NotRegistered();
    error AlreadyRegistered();
    error IdAlreadyUsed();
    error NotOwner();
    error InvalidInput();
    error UnknownAsset();
    error TagAlreadyRegistered();
    error ProductInactive();
    error WrongAssetType();
    error AssetAlreadyCovered();
    error InsufficientPool(uint256 available, uint256 required);
    error NotPolicyHolder();
    error PolicyNotActive();
    error OutsidePolicyPeriod();
    error WaitingPeriodNotElapsed();
    error ClaimNotPending();
    error AttestationExpired();
    error InvalidVet();
    error VetCannotBeClaimant();
    error NotYetExpired();
    error TooManyPolicies();
    error WithdrawExceedsAvailable(uint256 available);
    error AlreadyAttested();
    error InvalidQuorum();
    error InvalidStart();
    error InvalidCoverPeriod();
    error UnknownTriggerLevel();
    error UnderAssessment();

    modifier onlyFarmer() {
        if (!_farmers[msg.sender].exists) revert NotRegistered();
        _;
    }

    constructor(address admin, IERC20 token_) EIP712("FarmLedger", "1") {
        if (admin == address(0) || address(token_) == address(0)) revert InvalidInput();
        token = token_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // =================================================================
    // Registry (FR-01, FR-02)
    // =================================================================

    function registerFarmer(bytes32 idHash, bytes32 phoneHash) external whenNotPaused {
        if (_farmers[msg.sender].exists) revert AlreadyRegistered();
        if (idHash == bytes32(0) || phoneHash == bytes32(0)) revert InvalidInput();
        if (_idUsed[idHash]) revert IdAlreadyUsed();
        _idUsed[idHash] = true;
        _farmers[msg.sender] = Farmer({
            idHash: idHash,
            phoneHash: phoneHash,
            registeredAt: uint64(block.timestamp),
            exists: true
        });
        emit FarmerRegistered(msg.sender, idHash, phoneHash);
    }

    /// @notice A farmer whose SIM / number changed records the new number's hash (the portal or USSD service
    ///         verifies the new number with a one-time code first). The account and everything it owns stay the same.
    function updatePhone(bytes32 newPhoneHash) external onlyFarmer whenNotPaused {
        if (newPhoneHash == bytes32(0)) revert InvalidInput();
        _farmers[msg.sender].phoneHash = newPhoneHash;
        emit FarmerPhoneChanged(msg.sender, newPhoneHash);
    }

    function registerPlot(int32 latE6, int32 lonE6, uint32 areaM2, bytes32 crop, bytes32 geoHash)
        external onlyFarmer whenNotPaused returns (uint256)
    {
        return _registerPlot(msg.sender, latE6, lonE6, areaM2, crop, geoHash);
    }

    /// @notice An insurance agent recorded this plot for one of their farmers (checked by PolicyDesk).
    function registerPlotFor(address owner, int32 latE6, int32 lonE6, uint32 areaM2, bytes32 crop, bytes32 geoHash)
        external onlyRole(REGISTRAR_ROLE) whenNotPaused returns (uint256)
    {
        if (!_farmers[owner].exists) revert NotRegistered();
        return _registerPlot(owner, latE6, lonE6, areaM2, crop, geoHash);
    }

    function _registerPlot(address owner, int32 latE6, int32 lonE6, uint32 areaM2, bytes32 crop, bytes32 geoHash)
        private returns (uint256 plotId)
    {
        if (areaM2 == 0 || crop == bytes32(0)) revert InvalidInput();
        if (latE6 < -90_000_000 || latE6 > 90_000_000 || lonE6 < -180_000_000 || lonE6 > 180_000_000) revert InvalidInput();
        plotId = ++plotCount;
        _plots[plotId] = Plot({
            owner: owner,
            latE6: latE6,
            lonE6: lonE6,
            areaM2: areaM2,
            crop: crop,
            geoHash: geoHash,
            exists: true
        });
        _plotsOf[owner].push(plotId);
        emit PlotRegistered(plotId, owner, latE6, lonE6, areaM2, crop, geoHash);
    }

    function registerAnimal(bytes32 tagId, bytes32 breed, uint16 birthYear, bytes32 photoHash)
        external onlyFarmer whenNotPaused returns (uint256)
    {
        return _registerAnimal(msg.sender, tagId, breed, birthYear, photoHash);
    }

    /// @notice An insurance agent recorded this animal for one of their farmers (checked by PolicyDesk).
    function registerAnimalFor(address owner, bytes32 tagId, bytes32 breed, uint16 birthYear, bytes32 photoHash)
        external onlyRole(REGISTRAR_ROLE) whenNotPaused returns (uint256)
    {
        if (!_farmers[owner].exists) revert NotRegistered();
        return _registerAnimal(owner, tagId, breed, birthYear, photoHash);
    }

    function _registerAnimal(address owner, bytes32 tagId, bytes32 breed, uint16 birthYear, bytes32 photoHash)
        private returns (uint256 animalId)
    {
        if (tagId == bytes32(0)) revert InvalidInput();
        if (_animalByTag[tagId] != 0) revert TagAlreadyRegistered();
        animalId = ++animalCount;
        _animalByTag[tagId] = animalId;
        _animals[animalId] = Animal({
            owner: owner,
            tagId: tagId,
            breed: breed,
            birthYear: birthYear,
            photoHash: photoHash,
            deceased: false,
            exists: true
        });
        _animalsOf[owner].push(animalId);
        emit AnimalRegistered(animalId, owner, tagId, breed, birthYear, photoHash);
    }

    // =================================================================
    // Underwriter: products and liquidity (FR-03, FR-04)
    // =================================================================

    function createProduct(
        Cover cover,
        int256 threshold,
        uint16 rateBps,
        uint32 durationDays
    ) external onlyRole(UNDERWRITER_ROLE) returns (uint256 productId) {
        if (rateBps == 0 || rateBps > BPS || durationDays == 0) revert InvalidInput();
        productId = ++productCount;
        _products[productId] = Product({
            underwriter: msg.sender,
            cover: cover,
            threshold: threshold,
            rateBps: rateBps,
            durationDays: durationDays,
            active: true
        });
        _levels[productId].push(TriggerLevel({threshold: threshold, rateBps: rateBps}));
        emit ProductCreated(productId, msg.sender, cover, threshold, rateBps, durationDays);
        emit TriggerLevelAdded(productId, 0, threshold, rateBps);
    }

    /// @notice Offer another trigger for a weather product (e.g. a stricter drought level at a lower price).
    function addTriggerLevel(uint256 productId, int256 threshold, uint16 rateBps) external returns (uint8 level) {
        Product storage p = _products[productId];
        if (p.underwriter == address(0)) revert InvalidInput();
        if (p.underwriter != msg.sender) revert NotOwner();
        if (p.cover == Cover.Livestock) revert WrongAssetType();
        if (rateBps == 0 || rateBps > BPS) revert InvalidInput();
        if (_levels[productId].length >= MAX_TRIGGER_LEVELS) revert InvalidInput();
        level = uint8(_levels[productId].length);
        _levels[productId].push(TriggerLevel({threshold: threshold, rateBps: rateBps}));
        emit TriggerLevelAdded(productId, level, threshold, rateBps);
    }

    function setProductActive(uint256 productId, bool active) external {
        Product storage p = _products[productId];
        if (p.underwriter == address(0)) revert InvalidInput();
        if (p.underwriter != msg.sender) revert NotOwner();
        p.active = active;
        emit ProductStatusChanged(productId, active);
    }

    function depositLiquidity(uint256 amount) external onlyRole(UNDERWRITER_ROLE) nonReentrant {
        if (amount == 0) revert InvalidInput();
        poolBalance[msg.sender] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityDeposited(msg.sender, amount);
    }

    /// @notice Any pool owner may take out its unreserved funds, also after its underwriter role was revoked
    ///         (a suspended insurer sells nothing new, but its money is never locked in).
    function withdrawLiquidity(uint256 amount) external nonReentrant {
        uint256 available = poolBalance[msg.sender] - poolReserved[msg.sender];
        if (amount == 0 || amount > available) revert WithdrawExceedsAvailable(available);
        poolBalance[msg.sender] -= amount;
        token.safeTransfer(msg.sender, amount);
        emit LiquidityWithdrawn(msg.sender, amount);
    }

    // =================================================================
    // Policies (FR-03, FR-04)
    // =================================================================

    /// @notice Premium for a product and sum insured. Never rounds down to zero.
    function quotePremium(uint256 productId, uint256 sumInsured) public view returns (uint256) {
        Product storage p = _products[productId];
        if (p.underwriter == address(0)) revert InvalidInput();
        uint256 premium = (sumInsured * p.rateBps) / BPS;
        return premium == 0 ? 1 : premium;
    }

    /// @notice Premium for a chosen trigger level and cover length: the level's rate, pro-rated by days.
    ///         For the full product length and level 0 this equals quotePremium.
    function quoteCover(uint256 productId, uint8 level, uint256 sumInsured, uint32 coverDays) public view returns (uint256) {
        Product storage p = _products[productId];
        if (p.underwriter == address(0)) revert InvalidInput();
        if (level >= _levels[productId].length) revert UnknownTriggerLevel();
        if (coverDays == 0 || coverDays > p.durationDays) revert InvalidCoverPeriod();
        uint256 premium = (sumInsured * _levels[productId][level].rateBps * coverDays) / (uint256(BPS) * p.durationDays);
        return premium == 0 ? 1 : premium;
    }

    /// @notice Issues a policy. Farmers do not book directly: an insurance agent submits the application, the
    ///         underwriter drafts the contract and the farmer accepts and pays it, all in PolicyDesk, which then calls
    ///         this. The premium (minus any subsidy) is taken from the holder, who approved this contract.
    /// @param level        trigger level (see getTriggerLevels); 0 for livestock
    /// @param startAt      0 = now, otherwise a future time within MAX_START_DELAY (never in the past)
    /// @param coverDays    between MIN_COVER_DAYS (or the product length if shorter) and the product length
    /// @param contractHash hash of the signed contract document and application (recorded with the policy)
    function issuePolicy(
        address holder,
        uint256 productId,
        uint256 assetId,
        uint256 sumInsured,
        uint8 level,
        uint64 startAt,
        uint32 coverDays,
        bytes32 contractHash
    ) external onlyRole(ISSUER_ROLE) whenNotPaused nonReentrant returns (uint256 policyId) {
        if (!_farmers[holder].exists) revert NotRegistered();
        if (!hasRole(UNDERWRITER_ROLE, _products[productId].underwriter)) revert ProductInactive(); // suspended insurer
        policyId = _buy(holder, productId, assetId, sumInsured, level, startAt, coverDays);
        if (contractHash != bytes32(0)) {
            _applicationHash[policyId] = contractHash;
            emit ApplicationRecorded(policyId, holder, contractHash);
        }
    }

    function _buy(
        address holder,
        uint256 productId,
        uint256 assetId,
        uint256 sumInsured,
        uint8 level,
        uint64 startAt,
        uint32 coverDays
    ) private returns (uint256 policyId) {
        Product storage p = _products[productId];
        if (p.underwriter == address(0) || !p.active) revert ProductInactive();
        if (sumInsured == 0) revert InvalidInput();
        if (level >= _levels[productId].length) revert UnknownTriggerLevel();
        uint32 minDays = p.durationDays < MIN_COVER_DAYS ? p.durationDays : MIN_COVER_DAYS;
        if (coverDays < minDays || coverDays > p.durationDays) revert InvalidCoverPeriod();
        uint64 start = startAt == 0 ? uint64(block.timestamp) : startAt;
        if (start < block.timestamp || start > block.timestamp + MAX_START_DELAY) revert InvalidStart();

        if (p.cover == Cover.Livestock) {
            Animal storage a = _animals[assetId];
            if (!a.exists) revert UnknownAsset();
            if (a.owner != holder) revert NotOwner();
            if (a.deceased || _animalCovered[assetId]) revert AssetAlreadyCovered();
            _animalCovered[assetId] = true;
        } else {
            Plot storage pl = _plots[assetId];
            if (!pl.exists) revert UnknownAsset();
            if (pl.owner != holder) revert NotOwner();
            if (_activePolicesOfPlot[assetId].length >= MAX_POLICIES_PER_PLOT) revert TooManyPolicies();
        }

        uint256 available = poolBalance[p.underwriter] - poolReserved[p.underwriter];
        if (available < sumInsured) revert InsufficientPool(available, sumInsured);

        uint256 premium = quoteCover(productId, level, sumInsured, coverDays);
        policyId = ++policyCount;
        uint64 end = start + uint64(coverDays) * 1 days;
        int256 threshold = _levels[productId][level].threshold;

        _policies[policyId] = Policy({
            holder: holder,
            productId: productId,
            assetId: assetId,
            sumInsured: sumInsured,
            premium: premium,
            start: start,
            end: end,
            status: PolicyStatus.Active,
            level: level,
            threshold: threshold
        });
        _policiesOf[holder].push(policyId);
        if (p.cover != Cover.Livestock) _activePolicesOfPlot[assetId].push(policyId);

        uint256 subsidy = subsidyFor(holder, productId, premium);
        if (subsidy > 0) {
            subsidyPool -= subsidy;
            subsidyPaid += subsidy;
            subsidyUsed[holder] += subsidy;
            subsidyOf[policyId] = subsidy;
        }

        poolReserved[p.underwriter] += sumInsured;
        poolBalance[p.underwriter] += premium;
        Stats storage s = _stats[p.underwriter];
        s.premiums += premium;
        s.policiesSold += 1;

        token.safeTransferFrom(holder, address(this), premium - subsidy);
        emit PolicyPurchased(policyId, holder, productId, assetId, sumInsured, premium, start, end);
        emit PolicyTerms(policyId, level, threshold, coverDays);
        if (subsidy > 0) emit PremiumSubsidised(policyId, holder, subsidy, premium - subsidy);
    }

    /// @notice Anyone may close a policy that has run its course, releasing the reserved funds.
    function expirePolicy(uint256 policyId) external nonReentrant {
        Policy storage pol = _policies[policyId];
        if (pol.holder == address(0)) revert InvalidInput();
        if (pol.status != PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp <= pol.end) revert NotYetExpired();
        if (underAssessment[policyId]) revert UnderAssessment(); // reserve stays until the loss claim is decided
        pol.status = PolicyStatus.Expired;
        _closePolicy(policyId, pol);
        emit PolicyExpired(policyId);
    }

    // =================================================================
    // Mode 1: parametric crop / pasture claims (FR-05, FR-06)
    // =================================================================

    /// @notice Oracle feed. Stores the reading and pays every matching, triggered policy on the plot
    ///         in the same transaction - no human step in between.
    function postReading(
        uint256 plotId,
        Metric metric,
        int256 value,
        uint64 observedAt
    ) external onlyRole(ORACLE_ROLE) whenNotPaused nonReentrant {
        if (!_plots[plotId].exists) revert UnknownAsset();
        if (observedAt > block.timestamp) revert InvalidInput();

        _latestReading[plotId][metric] = Reading({
            value: value,
            observedAt: observedAt,
            postedAt: uint64(block.timestamp)
        });
        emit ReadingPosted(plotId, metric, value, observedAt);

        // Reverse iteration: _closePolicy swap-removes entries, which is safe when walking backwards.
        uint256[] storage list = _activePolicesOfPlot[plotId];
        for (uint256 i = list.length; i > 0; i--) {
            uint256 policyId = list[i - 1];
            Policy storage pol = _policies[policyId];
            Product storage prod = _products[pol.productId];
            if (pol.status != PolicyStatus.Active) continue;
            if (_metricOf(prod.cover) != metric) continue;
            if (block.timestamp < pol.start || block.timestamp > pol.end) continue;
            if (observedAt < pol.start) continue;
            if (!_isTriggered(prod.cover, pol.threshold, value)) continue;
            _payout(policyId, pol, prod, pol.sumInsured, true);
        }
    }

    // =================================================================
    // Mode 2: livestock claims with veterinary attestation (FR-07 .. FR-10)
    // =================================================================

    /// @notice The policy holder reports a death themselves (web portal).
    function fileClaim(uint256 policyId, bytes32 evidenceHash) external whenNotPaused returns (uint256 claimId) {
        if (_policies[policyId].holder != msg.sender) revert NotPolicyHolder();
        claimId = _fileClaim(policyId, evidenceHash);
        emit ClaimChannel(claimId, msg.sender, false);
    }

    /// @notice The USSD gateway registers a claim for a holder it has identified by SIM + PIN.
    ///         Restricted to CLAIMS_AGENT_ROLE; every eligibility rule below still applies.
    function fileClaimFor(uint256 policyId, bytes32 evidenceHash)
        external
        onlyRole(CLAIMS_AGENT_ROLE)
        whenNotPaused
        returns (uint256 claimId)
    {
        if (_policies[policyId].holder == address(0)) revert NotPolicyHolder();
        claimId = _fileClaim(policyId, evidenceHash);
        emit ClaimChannel(claimId, msg.sender, true);
    }

    function applicationHashOf(uint256 policyId) external view returns (bytes32) {
        return _applicationHash[policyId];
    }

    function _fileClaim(uint256 policyId, bytes32 evidenceHash) private returns (uint256 claimId) {
        Policy storage pol = _policies[policyId];
        if (_products[pol.productId].cover != Cover.Livestock) revert WrongAssetType();
        if (pol.status != PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp > pol.end) revert OutsidePolicyPeriod();
        if (block.timestamp < pol.start + waitingPeriod) revert WaitingPeriodNotElapsed();
        if (evidenceHash == bytes32(0)) revert InvalidInput();

        claimId = ++claimCount;
        _claims[claimId] = Claim({
            policyId: policyId,
            evidenceHash: evidenceHash,
            filedAt: uint64(block.timestamp),
            status: ClaimStatus.Pending,
            quorum: vetQuorum,
            approvals: 0,
            rejections: 0
        });
        pol.status = PolicyStatus.ClaimPending;
        emit ClaimFiled(claimId, policyId, pol.holder, _animals[pol.assetId].tagId, evidenceHash);
    }

    /// @notice Records one veterinarian's signed decision on a claim. Anyone may relay it, so a vet can sign
    ///         off-line (or through the USSD service) and a relayer pays the gas. The claim settles as soon as
    ///         `quorum` distinct certified vets have signed the same decision: approvals pay the farmer,
    ///         rejections close the claim and keep the policy active. With quorum 1 this is a single-vet decision.
    function settleLivestockClaim(
        uint256 claimId,
        bool approved,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused nonReentrant {
        Claim storage c = _claims[claimId];
        if (c.status != ClaimStatus.Pending) revert ClaimNotPending();
        if (block.timestamp > deadline) revert AttestationExpired();

        Policy storage pol = _policies[c.policyId];
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(ATTESTATION_TYPEHASH, claimId, c.policyId, _animals[pol.assetId].tagId, approved, deadline))
        );
        address signer = ECDSA.recover(digest, signature);
        if (!isCertifiedVet(signer)) revert InvalidVet();
        if (signer == pol.holder) revert VetCannotBeClaimant();
        if (_attested[claimId][signer]) revert AlreadyAttested();

        _attested[claimId][signer] = true;
        if (approved) c.approvals += 1; else c.rejections += 1;
        emit ClaimAttested(claimId, signer, approved, c.approvals, c.rejections);

        if (c.approvals >= c.quorum) {
            c.status = ClaimStatus.Approved;
            _animals[pol.assetId].deceased = true;
            emit ClaimSettled(claimId, c.policyId, true, signer);
            _payout(c.policyId, pol, _products[pol.productId], pol.sumInsured, false);
        } else if (c.rejections >= c.quorum) {
            c.status = ClaimStatus.Rejected;
            pol.status = PolicyStatus.Active; // cover continues
            emit ClaimSettled(claimId, c.policyId, false, signer);
        }
    }

    // =================================================================
    // Premium subsidy (government programme)
    // =================================================================

    /// @notice Subsidy a farmer would receive on a premium: the programme rate, limited by the farmer's remaining cap
    ///         and by the funds left in the pool. 0 if the product is not covered by the programme.
    function subsidyFor(address farmer, uint256 productId, uint256 premium) public view returns (uint256 subsidy) {
        SubsidyConfig storage c = subsidyConfig;
        if (c.rateBps == 0 || !subsidyEligible[productId]) return 0;
        subsidy = (premium * c.rateBps) / BPS;
        if (c.capPerFarmer != 0) {
            uint256 left = c.capPerFarmer > subsidyUsed[farmer] ? c.capPerFarmer - subsidyUsed[farmer] : 0;
            if (subsidy > left) subsidy = left;
        }
        if (subsidy > subsidyPool) subsidy = subsidyPool;
        if (subsidy >= premium) subsidy = premium - 1; // the farmer always pays something (moral hazard)
    }

    function fundSubsidy(uint256 amount) external onlyRole(SUBSIDY_ROLE) nonReentrant {
        if (amount == 0) revert InvalidInput();
        subsidyPool += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit SubsidyFunded(msg.sender, amount);
    }

    function withdrawSubsidy(uint256 amount) external onlyRole(SUBSIDY_ROLE) nonReentrant {
        if (amount == 0 || amount > subsidyPool) revert WithdrawExceedsAvailable(subsidyPool);
        subsidyPool -= amount;
        token.safeTransfer(msg.sender, amount);
        emit SubsidyWithdrawn(msg.sender, amount);
    }

    function setSubsidy(uint16 rateBps, uint256 capPerFarmer) external onlyRole(SUBSIDY_ROLE) {
        if (rateBps > MAX_SUBSIDY_BPS) revert InvalidInput();
        subsidyConfig = SubsidyConfig({rateBps: rateBps, capPerFarmer: capPerFarmer});
        emit SubsidyConfigured(rateBps, capPerFarmer);
    }

    function setSubsidyEligible(uint256 productId, bool eligible) external onlyRole(SUBSIDY_ROLE) {
        if (_products[productId].underwriter == address(0)) revert InvalidInput();
        subsidyEligible[productId] = eligible;
        emit SubsidyEligibility(productId, eligible);
    }

    // =================================================================
    // Crop loss assessment hooks (called by the CropClaims contract only)
    // =================================================================

    /// @notice Keeps a crop policy (and its reserve) open while a loss claim is reviewed. The policy stays Active,
    ///         so an automatic index payout can still happen during the review.
    function setAssessmentHold(uint256 policyId, bool held) external onlyRole(ASSESSOR_ROLE) {
        Policy storage pol = _policies[policyId];
        if (pol.holder == address(0) || _products[pol.productId].cover == Cover.Livestock) revert WrongAssetType();
        underAssessment[policyId] = held;
        emit AssessmentHold(policyId, held);
    }

    /// @notice Pays the loss amount the reviewers agreed (up to the sum insured) and closes the policy.
    function payAssessedLoss(uint256 policyId, uint256 amount) external onlyRole(ASSESSOR_ROLE) whenNotPaused nonReentrant {
        Policy storage pol = _policies[policyId];
        Product storage prod = _products[pol.productId];
        if (pol.holder == address(0) || prod.cover == Cover.Livestock) revert WrongAssetType();
        if (pol.status != PolicyStatus.Active) revert PolicyNotActive();
        if (amount == 0 || amount > pol.sumInsured) revert InvalidInput();
        _payout(policyId, pol, prod, amount, false);
    }

    // =================================================================
    // Admin
    // =================================================================

    function setWaitingPeriod(uint64 newPeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPeriod > MAX_WAITING_PERIOD) revert InvalidInput();
        waitingPeriod = newPeriod;
        emit WaitingPeriodChanged(newPeriod);
    }

    /// @notice Certifies (or renews) a veterinarian: records the licence and grants the vet role.
    function certifyVet(address vet, bytes32 licenseHash, bytes32 sector, uint64 validUntil)
        external
        onlyRole(VET_REGISTRAR_ROLE)
    {
        if (vet == address(0) || licenseHash == bytes32(0) || sector == bytes32(0)) revert InvalidInput();
        if (validUntil <= block.timestamp) revert InvalidInput();
        if (_vetProfiles[vet].certifiedAt == 0) _vetList.push(vet);
        _vetProfiles[vet] = VetProfile({
            licenseHash: licenseHash,
            sector: sector,
            certifiedAt: _vetProfiles[vet].certifiedAt == 0 ? uint64(block.timestamp) : _vetProfiles[vet].certifiedAt,
            validUntil: validUntil,
            active: true
        });
        _grantRole(VET_ROLE, vet);
        emit VetCertified(vet, licenseHash, sector, validUntil);
    }

    /// @notice Withdraws a vet's certification immediately (their signatures stop counting).
    function revokeVet(address vet) external onlyRole(VET_REGISTRAR_ROLE) {
        if (_vetProfiles[vet].certifiedAt == 0) revert InvalidInput();
        _vetProfiles[vet].active = false;
        _revokeRole(VET_ROLE, vet);
        emit VetRevoked(vet);
    }

    /// @notice Number of distinct vet signatures needed for claims filed from now on.
    function setVetQuorum(uint8 quorum) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (quorum == 0 || quorum > MAX_QUORUM) revert InvalidQuorum();
        vetQuorum = quorum;
        emit VetQuorumChanged(quorum);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // =================================================================
    // Views (used by the web client and dashboard, FR-12)
    // =================================================================

    function getFarmer(address farmer) external view returns (Farmer memory) {
        return _farmers[farmer];
    }

    function getPlot(uint256 id) external view returns (Plot memory) {
        return _plots[id];
    }

    function getAnimal(uint256 id) external view returns (Animal memory) {
        return _animals[id];
    }

    function getProduct(uint256 id) external view returns (Product memory) {
        return _products[id];
    }

    function getTriggerLevels(uint256 productId) external view returns (TriggerLevel[] memory) {
        return _levels[productId];
    }

    function getPolicy(uint256 id) external view returns (Policy memory) {
        return _policies[id];
    }

    function getClaim(uint256 id) external view returns (Claim memory) {
        return _claims[id];
    }

    function isCertifiedVet(address vet) public view returns (bool) {
        VetProfile storage p = _vetProfiles[vet];
        return p.active && block.timestamp <= p.validUntil && hasRole(VET_ROLE, vet);
    }

    function getVetProfile(address vet) external view returns (VetProfile memory) {
        return _vetProfiles[vet];
    }

    function getVets() external view returns (address[] memory) {
        return _vetList;
    }

    function hasAttested(uint256 claimId, address vet) external view returns (bool) {
        return _attested[claimId][vet];
    }

    function getLatestReading(uint256 plotId, Metric metric) external view returns (Reading memory) {
        return _latestReading[plotId][metric];
    }

    function plotsOf(address farmer) external view returns (uint256[] memory) {
        return _plotsOf[farmer];
    }

    function animalsOf(address farmer) external view returns (uint256[] memory) {
        return _animalsOf[farmer];
    }

    function policiesOf(address farmer) external view returns (uint256[] memory) {
        return _policiesOf[farmer];
    }

    function activePoliciesOfPlot(uint256 plotId) external view returns (uint256[] memory) {
        return _activePolicesOfPlot[plotId];
    }

    function animalIdByTag(bytes32 tagId) external view returns (uint256) {
        return _animalByTag[tagId];
    }

    function poolStats(address underwriter)
        external
        view
        returns (uint256 balance, uint256 reserved, uint256 available, Stats memory stats)
    {
        balance = poolBalance[underwriter];
        reserved = poolReserved[underwriter];
        available = balance - reserved;
        stats = _stats[underwriter];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // =================================================================
    // Internals
    // =================================================================

    function _metricOf(Cover cover) private pure returns (Metric) {
        return cover == Cover.LowNDVI ? Metric.NDVI : Metric.Rainfall;
    }

    function _isTriggered(Cover cover, int256 threshold, int256 value) private pure returns (bool) {
        if (cover == Cover.Flood) return value > threshold;
        return value < threshold; // Drought and LowNDVI
    }

    /// @dev `amount` is the sum insured, except for an assessed crop loss (which may be partial). The full reserve
    ///      is released either way.
    function _payout(uint256 policyId, Policy storage pol, Product storage prod, uint256 amount, bool automatic) private {
        pol.status = PolicyStatus.PaidOut;
        address underwriter = prod.underwriter;
        address holder = pol.holder;
        if (underAssessment[policyId]) { underAssessment[policyId] = false; emit AssessmentHold(policyId, false); }

        _closePolicy(policyId, pol);
        poolBalance[underwriter] -= amount;
        Stats storage s = _stats[underwriter];
        s.paidOut += amount;
        s.payouts += 1;

        token.safeTransfer(holder, amount);
        emit PayoutExecuted(policyId, holder, amount, prod.cover, automatic);
    }

    /// @dev Releases the reserve and removes the policy from the open lists. Status is set by the caller.
    function _closePolicy(uint256 policyId, Policy storage pol) private {
        Product storage prod = _products[pol.productId];
        poolReserved[prod.underwriter] -= pol.sumInsured;

        if (prod.cover == Cover.Livestock) {
            _animalCovered[pol.assetId] = false;
        } else {
            uint256[] storage list = _activePolicesOfPlot[pol.assetId];
            uint256 len = list.length;
            for (uint256 i = 0; i < len; i++) {
                if (list[i] == policyId) {
                    list[i] = list[len - 1];
                    list.pop();
                    break;
                }
            }
        }
    }
}
