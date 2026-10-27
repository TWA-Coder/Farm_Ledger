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

    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(uint256 claimId,uint256 policyId,bytes32 tagId,bool approved,uint256 deadline)");

    uint16 public constant BPS = 10_000;
    uint64 public constant MAX_WAITING_PERIOD = 30 days;
    uint256 public constant MAX_POLICIES_PER_PLOT = 25;

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

    mapping(uint256 => bytes32) private _applicationHash; // policyId -> hash of the booking application (data + documents)

    mapping(address => uint256) public poolBalance;   // underwriter => funds (liquidity + premiums - payouts)
    mapping(address => uint256) public poolReserved;  // underwriter => sum insured of open policies
    mapping(address => Stats) private _stats;

    // ---------------------------------------------------------------- events
    event FarmerRegistered(address indexed farmer, bytes32 idHash, bytes32 phoneHash);
    event PlotRegistered(uint256 indexed plotId, address indexed owner, int32 latE6, int32 lonE6, uint32 areaM2, bytes32 crop, bytes32 geoHash);
    event AnimalRegistered(uint256 indexed animalId, address indexed owner, bytes32 tagId, bytes32 breed, uint16 birthYear, bytes32 photoHash);
    event ProductCreated(uint256 indexed productId, address indexed underwriter, Cover cover, int256 threshold, uint16 rateBps, uint32 durationDays);
    event ProductStatusChanged(uint256 indexed productId, bool active);
    event LiquidityDeposited(address indexed underwriter, uint256 amount);
    event LiquidityWithdrawn(address indexed underwriter, uint256 amount);
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
    error ApplicationAlreadyRecorded();

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

    function registerPlot(
        int32 latE6,
        int32 lonE6,
        uint32 areaM2,
        bytes32 crop,
        bytes32 geoHash
    ) external onlyFarmer whenNotPaused returns (uint256 plotId) {
        if (areaM2 == 0 || crop == bytes32(0)) revert InvalidInput();
        if (latE6 < -90_000_000 || latE6 > 90_000_000 || lonE6 < -180_000_000 || lonE6 > 180_000_000) revert InvalidInput();
        plotId = ++plotCount;
        _plots[plotId] = Plot({
            owner: msg.sender,
            latE6: latE6,
            lonE6: lonE6,
            areaM2: areaM2,
            crop: crop,
            geoHash: geoHash,
            exists: true
        });
        _plotsOf[msg.sender].push(plotId);
        emit PlotRegistered(plotId, msg.sender, latE6, lonE6, areaM2, crop, geoHash);
    }

    function registerAnimal(
        bytes32 tagId,
        bytes32 breed,
        uint16 birthYear,
        bytes32 photoHash
    ) external onlyFarmer whenNotPaused returns (uint256 animalId) {
        if (tagId == bytes32(0)) revert InvalidInput();
        if (_animalByTag[tagId] != 0) revert TagAlreadyRegistered();
        animalId = ++animalCount;
        _animalByTag[tagId] = animalId;
        _animals[animalId] = Animal({
            owner: msg.sender,
            tagId: tagId,
            breed: breed,
            birthYear: birthYear,
            photoHash: photoHash,
            deceased: false,
            exists: true
        });
        _animalsOf[msg.sender].push(animalId);
        emit AnimalRegistered(animalId, msg.sender, tagId, breed, birthYear, photoHash);
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
        emit ProductCreated(productId, msg.sender, cover, threshold, rateBps, durationDays);
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

    function withdrawLiquidity(uint256 amount) external onlyRole(UNDERWRITER_ROLE) nonReentrant {
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

    function buyPolicy(
        uint256 productId,
        uint256 assetId,
        uint256 sumInsured
    ) external onlyFarmer whenNotPaused nonReentrant returns (uint256 policyId) {
        Product storage p = _products[productId];
        if (p.underwriter == address(0) || !p.active) revert ProductInactive();
        if (sumInsured == 0) revert InvalidInput();

        if (p.cover == Cover.Livestock) {
            Animal storage a = _animals[assetId];
            if (!a.exists) revert UnknownAsset();
            if (a.owner != msg.sender) revert NotOwner();
            if (a.deceased || _animalCovered[assetId]) revert AssetAlreadyCovered();
            _animalCovered[assetId] = true;
        } else {
            Plot storage pl = _plots[assetId];
            if (!pl.exists) revert UnknownAsset();
            if (pl.owner != msg.sender) revert NotOwner();
            if (_activePolicesOfPlot[assetId].length >= MAX_POLICIES_PER_PLOT) revert TooManyPolicies();
        }

        uint256 available = poolBalance[p.underwriter] - poolReserved[p.underwriter];
        if (available < sumInsured) revert InsufficientPool(available, sumInsured);

        uint256 premium = quotePremium(productId, sumInsured);
        policyId = ++policyCount;
        uint64 start = uint64(block.timestamp);
        uint64 end = start + uint64(p.durationDays) * 1 days;

        _policies[policyId] = Policy({
            holder: msg.sender,
            productId: productId,
            assetId: assetId,
            sumInsured: sumInsured,
            premium: premium,
            start: start,
            end: end,
            status: PolicyStatus.Active
        });
        _policiesOf[msg.sender].push(policyId);
        if (p.cover != Cover.Livestock) _activePolicesOfPlot[assetId].push(policyId);

        poolReserved[p.underwriter] += sumInsured;
        poolBalance[p.underwriter] += premium;
        Stats storage s = _stats[p.underwriter];
        s.premiums += premium;
        s.policiesSold += 1;

        token.safeTransferFrom(msg.sender, address(this), premium);
        emit PolicyPurchased(policyId, msg.sender, productId, assetId, sumInsured, premium, start, end);
    }

    /// @notice Anyone may close a policy that has run its course, releasing the reserved funds.
    function expirePolicy(uint256 policyId) external nonReentrant {
        Policy storage pol = _policies[policyId];
        if (pol.holder == address(0)) revert InvalidInput();
        if (pol.status != PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp <= pol.end) revert NotYetExpired();
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
            if (!_isTriggered(prod.cover, prod.threshold, value)) continue;
            _payout(policyId, pol, prod, true);
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

    /// @notice Anchors the booking application (form data + uploaded documents) to the policy by hash,
    ///         so the off-chain file set cannot be altered later without detection. Holder only, once.
    function recordApplication(uint256 policyId, bytes32 applicationHash) external {
        Policy storage pol = _policies[policyId];
        if (pol.holder != msg.sender) revert NotPolicyHolder();
        if (applicationHash == bytes32(0)) revert InvalidInput();
        if (_applicationHash[policyId] != bytes32(0)) revert ApplicationAlreadyRecorded();
        _applicationHash[policyId] = applicationHash;
        emit ApplicationRecorded(policyId, msg.sender, applicationHash);
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
            _payout(c.policyId, pol, _products[pol.productId], false);
        } else if (c.rejections >= c.quorum) {
            c.status = ClaimStatus.Rejected;
            pol.status = PolicyStatus.Active; // cover continues
            emit ClaimSettled(claimId, c.policyId, false, signer);
        }
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
        onlyRole(DEFAULT_ADMIN_ROLE)
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
    function revokeVet(address vet) external onlyRole(DEFAULT_ADMIN_ROLE) {
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

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
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

    function _payout(uint256 policyId, Policy storage pol, Product storage prod, bool automatic) private {
        pol.status = PolicyStatus.PaidOut;
        address underwriter = prod.underwriter;
        uint256 amount = pol.sumInsured;
        address holder = pol.holder;

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
