// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Test stand-in for a Rwandan-franc stablecoin / Mobile Money balance (0 decimals: 1 token = 1 RWF).
///         `openFaucet` (local demo chain only): anyone may mint test money. Otherwise only accounts the owner made
///         minters may mint, i.e. the treasury that credits farmers against confirmed Mobile Money payments.
contract MockRWF is ERC20, Ownable {
    bool public immutable openFaucet;
    mapping(address => bool) public isMinter;

    event MinterChanged(address indexed account, bool allowed);
    error NotMinter();

    constructor(bool openFaucet_) ERC20("Mock Rwandan Franc", "mRWF") Ownable(msg.sender) {
        openFaucet = openFaucet_;
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function setMinter(address account, bool allowed) external onlyOwner {
        isMinter[account] = allowed;
        emit MinterChanged(account, allowed);
    }

    function mint(address to, uint256 amount) external {
        if (!openFaucet && !isMinter[msg.sender]) revert NotMinter();
        _mint(to, amount);
    }
}
