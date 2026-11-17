// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
/// Minimal ERC-20 used as the deal sell-token on the LOCAL fork only.
contract MockERC20 {
    string public name = "Mock Token";
    string public symbol = "MOCK";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; totalSupply += amt; emit Transfer(address(0), to, amt); }
    function approve(address sp, uint256 amt) external returns (bool) { allowance[msg.sender][sp] = amt; emit Approval(msg.sender, sp, amt); return true; }
    function transfer(address to, uint256 amt) external returns (bool) { _move(msg.sender, to, amt); return true; }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amt, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amt;
        _move(from, to, amt);
        return true;
    }
    function _move(address from, address to, uint256 amt) internal {
        require(balanceOf[from] >= amt, "balance");
        balanceOf[from] -= amt; balanceOf[to] += amt; emit Transfer(from, to, amt);
    }
}
