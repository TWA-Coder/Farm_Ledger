// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/samples/SimpleAccount.sol";

/// @title FarmLedgerPaymaster
/// @notice Pays the network fees for farmers' smart accounts, so farmers never need ETH.
///         It sponsors a UserOperation only if every call it makes goes to an allowed contract (FarmLedger and the
///         payment token) with no ETH value, and only up to a maximum cost per operation. Anything else is refused,
///         so the sponsor's deposit cannot be spent on arbitrary transactions.
contract FarmLedgerPaymaster is BasePaymaster {
    mapping(address => bool) public allowedTarget;
    uint256 public maxCostPerOp;

    error TargetNotAllowed(address target);
    error ValueNotAllowed();
    error UnsupportedCall(bytes4 selector);
    error TooExpensive(uint256 maxCost, uint256 limit);

    event TargetAllowed(address indexed target, bool allowed);
    event MaxCostChanged(uint256 maxCostPerOp);

    constructor(IEntryPoint entryPoint_, address[] memory targets, uint256 maxCostPerOp_) BasePaymaster(entryPoint_) {
        for (uint256 i = 0; i < targets.length; i++) {
            allowedTarget[targets[i]] = true;
            emit TargetAllowed(targets[i], true);
        }
        maxCostPerOp = maxCostPerOp_;
        emit MaxCostChanged(maxCostPerOp_);
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTarget[target] = allowed;
        emit TargetAllowed(target, allowed);
    }

    function setMaxCostPerOp(uint256 limit) external onlyOwner {
        maxCostPerOp = limit;
        emit MaxCostChanged(limit);
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        if (maxCost > maxCostPerOp) revert TooExpensive(maxCost, maxCostPerOp);
        bytes calldata data = userOp.callData;
        if (data.length < 4) revert UnsupportedCall(bytes4(0));
        bytes4 selector = bytes4(data[:4]);
        if (selector == SimpleAccount.execute.selector) {
            (address dest, uint256 value, ) = abi.decode(data[4:], (address, uint256, bytes));
            _check(dest, value);
        } else if (selector == SimpleAccount.executeBatch.selector) {
            (address[] memory dest, uint256[] memory value, ) = abi.decode(data[4:], (address[], uint256[], bytes[]));
            for (uint256 i = 0; i < dest.length; i++) _check(dest[i], value.length == 0 ? 0 : value[i]);
        } else {
            revert UnsupportedCall(selector);
        }
        return ("", 0); // no postOp needed; valid indefinitely
    }

    function _check(address dest, uint256 value) private view {
        if (!allowedTarget[dest]) revert TargetNotAllowed(dest);
        if (value != 0) revert ValueNotAllowed();
    }
}
