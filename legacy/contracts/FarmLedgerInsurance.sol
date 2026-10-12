
 // SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title FarmLedger Agricultural Insurance
/// @notice Educational prototype for crop and livestock parametric insurance.
/// @dev Uses native test ETH for premiums and payouts.
///      An authorized verifier supplies evidence; no live oracle is connected.
contract FarmLedgerInsurance {
    address public owner;
    address public verifier;
    uint256 public nextPolicyId = 1;
    uint256 public reservedPayouts;

    enum InsuranceType {
        Crop,
        Livestock
    }

    struct Policy {
        address farmer;
        InsuranceType insuranceType;
        uint256 premium;
        uint256 payoutAmount;
        uint256 startTime;
        uint256 endTime;
        bool active;
        bool paid;
    }

    mapping(uint256 => Policy) public policies;

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed farmer,
        InsuranceType insuranceType,
        uint256 premium,
        uint256 payoutAmount
    );

    event EvidenceVerified(
        uint256 indexed policyId,
        bytes32 evidenceHash
    );

    event PayoutMade(
        uint256 indexed policyId,
        address indexed farmer,
        uint256 amount
    );

    event VerifierUpdated(address indexed newVerifier);
    event PoolFunded(address indexed funder, uint256 amount);
    event PolicyExpired(uint256 indexed policyId);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not contract owner");
        _;
    }

    modifier onlyVerifier() {
        require(msg.sender == verifier, "Not authorized verifier");
        _;
    }

    constructor(address initialVerifier) {
        require(initialVerifier != address(0), "Invalid verifier");

        owner = msg.sender;
        verifier = initialVerifier;
    }

    /// @notice Add funds to the insurance pool.
    function fundPool() external payable {
        require(msg.value > 0, "Funding must be positive");
        emit PoolFunded(msg.sender, msg.value);
    }

    /// @notice Register a crop or livestock policy by paying its premium.
    /// @param insuranceType 0 = Crop, 1 = Livestock.
    /// @param payoutAmount Maximum payout, denominated in wei.
    /// @param durationSeconds Policy duration in seconds.
    function buyPolicy(
        InsuranceType insuranceType,
        uint256 payoutAmount,
        uint256 durationSeconds
    ) external payable returns (uint256 policyId) {
        require(msg.value > 0, "Premium must be positive");
        require(payoutAmount > 0, "Payout must be positive");
        require(durationSeconds > 0, "Invalid duration");
        require(
            address(this).balance >= reservedPayouts + payoutAmount,
            "Insufficient available pool funds"
        );

        policyId = nextPolicyId++;
        reservedPayouts += payoutAmount;

        policies[policyId] = Policy({
            farmer: msg.sender,
            insuranceType: insuranceType,
            premium: msg.value,
            payoutAmount: payoutAmount,
            startTime: block.timestamp,
            endTime: block.timestamp + durationSeconds,
            active: true,
            paid: false
        });

        emit PolicyCreated(
            policyId,
            msg.sender,
            insuranceType,
            msg.value,
            payoutAmount
        );
    }

    /// @notice Update the authorized evidence verifier.
    function setVerifier(address newVerifier) external onlyOwner {
        require(newVerifier != address(0), "Invalid verifier");
        verifier = newVerifier;
        emit VerifierUpdated(newVerifier);
    }

    /// @notice Approve a claim and pay the farmer from the pool.
    /// @dev Only the verifier can call this in the prototype.
    /// @param policyId The policy being evaluated.
    /// @param evidenceHash Hash of off-chain evidence, not the raw document.
    function verifyAndPay(
        uint256 policyId,
        bytes32 evidenceHash
    ) external onlyVerifier {
        Policy storage policy = policies[policyId];

        require(policy.farmer != address(0), "Policy does not exist");
        require(policy.active, "Policy is inactive");
        require(!policy.paid, "Already paid");
        require(block.timestamp <= policy.endTime, "Policy expired");
        require(evidenceHash != bytes32(0), "Evidence required");
        require(
            address(this).balance >= policy.payoutAmount,
            "Insufficient pool funds"
        );

        // Update state before transferring funds.
        policy.paid = true;
        policy.active = false;
        reservedPayouts -= policy.payoutAmount;

        emit EvidenceVerified(policyId, evidenceHash);

        (bool success, ) = payable(policy.farmer).call{
            value: policy.payoutAmount
        }("");

        require(success, "Payout transfer failed");

        emit PayoutMade(
            policyId,
            policy.farmer,
            policy.payoutAmount
        );
    }

    /// @notice Expire a policy after its coverage period and release its reserved payout.
    /// @dev Anyone may call this; it does not transfer funds to the caller or farmer.
    function expirePolicy(uint256 policyId) external {
        Policy storage policy = policies[policyId];

        require(policy.farmer != address(0), "Policy does not exist");
        require(policy.active, "Policy is inactive");
        require(block.timestamp > policy.endTime, "Policy has not expired");

        policy.active = false;
        reservedPayouts -= policy.payoutAmount;

        emit PolicyExpired(policyId);
    }

    /// @notice Read the current insurance pool balance.
    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Read pool funds not committed to active policies.
    function availablePoolBalance() external view returns (uint256) {
        return address(this).balance - reservedPayouts;
    }

    /// @notice Read a policy's complete details.
    function getPolicy(
        uint256 policyId
    ) external view returns (Policy memory) {
        require(
            policies[policyId].farmer != address(0),
            "Policy does not exist"
        );
        return policies[policyId];
    }
}
