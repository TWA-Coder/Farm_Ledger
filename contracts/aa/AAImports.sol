// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Compiles the standard ERC-4337 v0.7 contracts (eth-infinitism reference implementation) so the deploy script
// can deploy them on the local chain. On public networks the canonical EntryPoint is already deployed.
import "@account-abstraction/contracts/core/EntryPoint.sol";
import "@account-abstraction/contracts/samples/SimpleAccountFactory.sol";
