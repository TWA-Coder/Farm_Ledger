// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockRWF
/// @notice Test-only stable token that stands in for Rwandan francs held in the escrow pool.
///         In production the payout leg is a Mobile Money disbursement (see services/notifier.js).
///         Zero decimals: 1 token = 1 RWF, which keeps demo numbers readable.
contract MockRWF is ERC20 {
    constructor() ERC20("Mock Rwandan Franc", "mRWF") {}

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    /// @notice Open faucet - TESTNET/DEMO ONLY.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
