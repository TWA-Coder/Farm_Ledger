// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FarmLedger} from "./FarmLedger.sol";

/// @title CropClaims
/// @notice Loss claims on crop policies, decided by the underwriter's claim reviewers (M-of-N).
///   Index cover pays automatically when the oracle reading crosses the trigger. A farmer can still suffer a loss the
///   index misses (hail on one field, pests, a rain gauge far away: "basis risk"). They file a claim here with
///   evidence (photos, an extension officer's report: hashed, files kept off-chain). The underwriter's reviewers
///   then vote; the claim pays when `quorum` distinct reviewers approve the SAME amount, or closes when `quorum`
///   reject it. The quorum is fixed when the claim is filed.
///
///   Reviewers belong to an underwriter: the underwriter account itself plus the reviewers it adds. A reviewer can
///   only decide claims on that underwriter's policies, never their own. The payout comes from the underwriter's
///   pool through FarmLedger.payAssessedLoss, which only this contract may call (ASSESSOR_ROLE).
///
///   While a claim is open the policy cannot be expired (its reserve stays), but it stays Active: if the index
///   triggers during the review the automatic payout still happens and the claim is closed as superseded.
contract CropClaims {
    enum Status { None, Pending, Approved, Rejected, Superseded }

    struct Claim {
        uint256 policyId;
        address holder;
        address underwriter;
        bytes32 evidenceHash;   // hash of the evidence bundle (photos, report), files kept off-chain
        uint256 requested;      // farmer's estimate of the loss, 0 = "please assess"
        uint256 amount;         // amount the approving reviewers agreed on
        uint64 filedAt;
        Status status;
        uint8 quorum;
        uint8 approvals;
        uint8 rejections;
    }

    uint8 public constant MAX_QUORUM = 5;
    uint8 public constant MAX_CLAIMS_PER_POLICY = 3;

    FarmLedger public immutable ledger;
    uint256 public claimCount;
    mapping(uint256 => Claim) private _claims;
    mapping(uint256 => uint256) public openClaimOf;                     // policyId => open claim id (0 = none)
    mapping(uint256 => uint8) public claimsFiledOn;                     // policyId => claims filed so far
    mapping(uint256 => mapping(address => bool)) public hasReviewed;    // claimId => reviewer => voted

    mapping(address => mapping(address => bool)) private _reviewer;     // underwriter => reviewer => allowed
    mapping(address => address[]) private _reviewerList;
    mapping(address => uint8) private _quorum;                          // underwriter => quorum (0 = 1)

    event ReviewerChanged(address indexed underwriter, address indexed reviewer, bool allowed);
    event ReviewQuorumChanged(address indexed underwriter, uint8 quorum);
    event CropClaimFiled(uint256 indexed claimId, uint256 indexed policyId, address indexed holder, bytes32 evidenceHash, uint256 requested, uint8 quorum, bool viaAgent);
    event CropClaimReviewed(uint256 indexed claimId, address indexed reviewer, bool approved, uint256 amount, uint8 approvals, uint8 rejections);
    event CropClaimSettled(uint256 indexed claimId, uint256 indexed policyId, Status status, uint256 amount);

    error NotUnderwriter();
    error NotPolicyHolder();
    error NotReviewer();
    error ReviewerIsHolder();
    error AlreadyReviewed();
    error ClaimNotPending();
    error ClaimAlreadyOpen();
    error TooManyClaims();
    error WrongCover();
    error PolicyNotActive();
    error OutsidePolicyPeriod();
    error InvalidInput();
    error InvalidQuorum();
    error AmountMismatch(uint256 agreed);
    error Paused();

    constructor(FarmLedger ledger_) {
        if (address(ledger_) == address(0)) revert InvalidInput();
        ledger = ledger_;
    }

    // ---------------------------------------------------------------- reviewers (per underwriter)

    modifier onlyUnderwriter() {
        if (!ledger.hasRole(ledger.UNDERWRITER_ROLE(), msg.sender)) revert NotUnderwriter();
        _;
    }

    function setReviewer(address reviewer, bool allowed) external onlyUnderwriter {
        if (reviewer == address(0) || reviewer == msg.sender) revert InvalidInput();
        if (_reviewer[msg.sender][reviewer] == allowed) return;
        _reviewer[msg.sender][reviewer] = allowed;
        if (allowed) {
            _reviewerList[msg.sender].push(reviewer);
        } else {
            address[] storage list = _reviewerList[msg.sender];
            for (uint256 i = 0; i < list.length; i++) {
                if (list[i] == reviewer) { list[i] = list[list.length - 1]; list.pop(); break; }
            }
            if (reviewQuorum(msg.sender) > list.length + 1) { _quorum[msg.sender] = uint8(list.length + 1); emit ReviewQuorumChanged(msg.sender, uint8(list.length + 1)); }
        }
        emit ReviewerChanged(msg.sender, reviewer, allowed);
    }

    /// @notice Reviewer approvals (or rejections) needed for claims filed from now on. The underwriter counts as one.
    function setReviewQuorum(uint8 quorum) external onlyUnderwriter {
        if (quorum == 0 || quorum > MAX_QUORUM || quorum > _reviewerList[msg.sender].length + 1) revert InvalidQuorum();
        _quorum[msg.sender] = quorum;
        emit ReviewQuorumChanged(msg.sender, quorum);
    }

    function reviewQuorum(address underwriter) public view returns (uint8) {
        uint8 q = _quorum[underwriter];
        return q == 0 ? 1 : q;
    }

    function isReviewer(address underwriter, address who) public view returns (bool) {
        return who == underwriter || _reviewer[underwriter][who];
    }

    function reviewersOf(address underwriter) external view returns (address[] memory) {
        return _reviewerList[underwriter];
    }

    // ---------------------------------------------------------------- filing

    /// @notice The policy holder files a loss claim (portal, or their phone account through the USSD service).
    function fileClaim(uint256 policyId, bytes32 evidenceHash, uint256 requested) external returns (uint256) {
        if (ledger.getPolicy(policyId).holder != msg.sender) revert NotPolicyHolder();
        return _file(policyId, evidenceHash, requested, false);
    }

    /// @notice The USSD gateway files for a holder it identified by SIM + PIN (same limited role as for livestock).
    function fileClaimFor(uint256 policyId, bytes32 evidenceHash, uint256 requested) external returns (uint256) {
        if (!ledger.hasRole(ledger.CLAIMS_AGENT_ROLE(), msg.sender)) revert NotPolicyHolder();
        return _file(policyId, evidenceHash, requested, true);
    }

    function _file(uint256 policyId, bytes32 evidenceHash, uint256 requested, bool viaAgent) private returns (uint256 claimId) {
        if (ledger.paused()) revert Paused();
        FarmLedger.Policy memory pol = ledger.getPolicy(policyId);
        if (pol.holder == address(0)) revert NotPolicyHolder();
        FarmLedger.Product memory prod = ledger.getProduct(pol.productId);
        if (prod.cover == FarmLedger.Cover.Livestock) revert WrongCover(); // livestock claims go to the vets
        if (pol.status != FarmLedger.PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp < pol.start || block.timestamp > pol.end) revert OutsidePolicyPeriod();
        if (evidenceHash == bytes32(0) || requested > pol.sumInsured) revert InvalidInput();
        if (openClaimOf[policyId] != 0) revert ClaimAlreadyOpen();
        if (claimsFiledOn[policyId] >= MAX_CLAIMS_PER_POLICY) revert TooManyClaims();

        claimId = ++claimCount;
        uint8 quorum = reviewQuorum(prod.underwriter);
        _claims[claimId] = Claim({
            policyId: policyId,
            holder: pol.holder,
            underwriter: prod.underwriter,
            evidenceHash: evidenceHash,
            requested: requested,
            amount: 0,
            filedAt: uint64(block.timestamp),
            status: Status.Pending,
            quorum: quorum,
            approvals: 0,
            rejections: 0
        });
        openClaimOf[policyId] = claimId;
        claimsFiledOn[policyId] += 1;
        ledger.setAssessmentHold(policyId, true);
        emit CropClaimFiled(claimId, policyId, pol.holder, evidenceHash, requested, quorum, viaAgent);
    }

    // ---------------------------------------------------------------- review

    /// @notice One reviewer's decision. `amount` is the assessed loss (ignored for a rejection). The first approval
    ///         sets the amount; every further approval must confirm the same amount, so the payout is what M people
    ///         agreed, not what one person typed.
    function review(uint256 claimId, bool approve, uint256 amount) external {
        Claim storage c = _claims[claimId];
        if (c.status != Status.Pending) revert ClaimNotPending();
        if (!isReviewer(c.underwriter, msg.sender)) revert NotReviewer();
        if (msg.sender == c.holder) revert ReviewerIsHolder();
        if (hasReviewed[claimId][msg.sender]) revert AlreadyReviewed();
        if (_supersede(claimId, c)) return; // the index already paid this policy

        if (approve) {
            FarmLedger.Policy memory pol = ledger.getPolicy(c.policyId);
            if (amount == 0 || amount > pol.sumInsured) revert InvalidInput();
            if (c.approvals == 0) c.amount = amount;
            else if (amount != c.amount) revert AmountMismatch(c.amount);
            c.approvals += 1;
        } else {
            c.rejections += 1;
        }
        hasReviewed[claimId][msg.sender] = true;
        emit CropClaimReviewed(claimId, msg.sender, approve, approve ? amount : 0, c.approvals, c.rejections);

        if (c.approvals >= c.quorum) {
            c.status = Status.Approved;
            openClaimOf[c.policyId] = 0;
            emit CropClaimSettled(claimId, c.policyId, Status.Approved, c.amount);
            ledger.payAssessedLoss(c.policyId, c.amount); // releases the hold, pays from the underwriter's pool
        } else if (c.rejections >= c.quorum) {
            c.status = Status.Rejected;
            openClaimOf[c.policyId] = 0;
            ledger.setAssessmentHold(c.policyId, false); // cover continues; the policy can expire normally again
            emit CropClaimSettled(claimId, c.policyId, Status.Rejected, 0);
        }
    }

    /// @notice Anyone may close a claim whose policy was already paid by the index (keeps the lists tidy).
    function closeSuperseded(uint256 claimId) external {
        Claim storage c = _claims[claimId];
        if (c.status != Status.Pending || !_supersede(claimId, c)) revert ClaimNotPending();
    }

    function _supersede(uint256 claimId, Claim storage c) private returns (bool) {
        if (ledger.getPolicy(c.policyId).status == FarmLedger.PolicyStatus.Active) return false;
        c.status = Status.Superseded;
        openClaimOf[c.policyId] = 0;
        emit CropClaimSettled(claimId, c.policyId, Status.Superseded, 0);
        return true;
    }

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return _claims[claimId];
    }
}
