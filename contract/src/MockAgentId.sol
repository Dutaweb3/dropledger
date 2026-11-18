// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAgentId
/// @notice TESTNET-ONLY stand-in for the SPACE ID Agent ID registry.
/// @dev The real Agent ID registry (0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F)
///      is mainnet-only: it has no code on BNB Chain Testnet. This mock
///      implements only the `balanceOf` interface DropLedger checks, so the
///      testnet deployment behaves like mainnet for testing. NEVER deploy
///      this to mainnet or point a mainnet DropLedger at it.
contract MockAgentId {
    mapping(address => uint256) public balanceOf;

    function mint(address to) external {
        balanceOf[to] = 1;
    }

    function burn(address from) external {
        balanceOf[from] = 0;
    }
}
