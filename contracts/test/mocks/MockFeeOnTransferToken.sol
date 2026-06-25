// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev ERC20 that skims `feeBps` basis points off every non-mint/non-burn
///      transfer (sending the skim to a dead sink), so the recipient receives
///      strictly less than the sent amount. The canonical fee-on-transfer
///      adversary for balance-delta accounting tests. Construct with the fee in
///      basis points (e.g. `100` = 1%).
contract MockFeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps;
    address internal constant SINK = address(0xdead);

    constructor(uint256 _feeBps) ERC20("Fee Token", "FEE") {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && to != SINK && feeBps != 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, to, value - fee);
            super._update(from, SINK, fee);
        } else {
            super._update(from, to, value);
        }
    }
}
