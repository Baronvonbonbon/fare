// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./lib/PaseoSafeSender.sol";
import "./lib/FareUpgradable.sol";

/// @title FareVault
/// @notice Single pull-payment vault for every native-token payout in the
///         protocol: venue order-value releases, driver fares + tips,
///         customer refunds, dispute splits, protocol fees. Authorized
///         protocol contracts push value in via `credit{value:}`; recipients
///         pull with `withdraw`. One money-out path keeps the escrow
///         invariants auditable and removes push-payment griefing
///         (a reverting recipient can never block a settlement).
/// @dev Inherits FareUpgradable for registry/version consistency, but NO
///      function here is `whenNotFrozen`: the vault is the drain path for
///      every other contract's freeze-and-drain upgrade, so it must never
///      block. Upgrade it with `freezeOld = false` — re-point consumers via
///      their configure() setters and leave v1 live until balances hit zero.
contract FareVault is Ownable2Step, PaseoSafeSender, FareUpgradable, EIP712 {
    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public authorized;
    uint256 public totalCredited;
    uint256 public totalWithdrawn;

    // ERC-20 stablecoin escrow (C3): a second money-out ledger, keyed by token.
    // Same pull-payment shape as native — authorized protocol contracts push
    // value in via `creditToken`, recipients pull with `withdrawToken`. Native
    // and token balances are independent; an order settles wholly in one asset.
    mapping(address => mapping(address => uint256)) public tokenBalanceOf; // token => account => balance

    // Relay-submitted gasless withdrawal (F8): a small fee on `withdrawFor` goes
    // to the submitting relay to reimburse its gas, so a driver can pull earnings
    // with zero gas of their own. Direct withdraw()/withdrawTo() are always free.
    uint16 public withdrawFeeBps; // default 0 (dormant); governance enables it
    mapping(address => uint256) public withdrawNonce; // replay guard per account
    bytes32 private constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address account,address recipient,uint256 nonce,uint256 deadline)");

    event Credited(address indexed to, address indexed from, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    event AuthorizedSet(address indexed account, bool enabled);
    event RelayWithdrawFee(address indexed relay, address indexed account, uint256 fee);
    event WithdrawFeeSet(uint16 bps);
    event TokenCredited(address indexed token, address indexed to, address indexed from, uint256 amount, uint256 newBalance);
    event TokenWithdrawn(address indexed token, address indexed account, address indexed to, uint256 amount);

    constructor() Ownable(msg.sender) EIP712("FareVault", "1") {}

    /// @notice Fee (bps of the withdrawal) paid to the relay that submits a
    ///         `withdrawFor`, to reimburse its gas. 0 disables (default).
    function setWithdrawFeeBps(uint16 bps) external onlyOwner {
        require(bps <= 1000, "fee-too-high"); // 10% hard cap
        withdrawFeeBps = bps;
        emit WithdrawFeeSet(bps);
    }

    /// @notice One-time binding to the FareGovernanceRouter (upgrade authority).
    function setRouter(address _router) external onlyOwner {
        _setRouterOnce(_router);
    }

    function setAuthorized(address account, bool enabled) external onlyOwner {
        require(account != address(0), "zero-addr");
        authorized[account] = enabled;
        emit AuthorizedSet(account, enabled);
    }

    /// @notice Credit `to` with the attached value. Protocol contracts only.
    function credit(address to) external payable {
        require(authorized[msg.sender], "not-authorized");
        require(to != address(0), "zero-addr");
        require(msg.value > 0, "zero-value");
        balanceOf[to] += msg.value;
        totalCredited += msg.value;
        emit Credited(to, msg.sender, msg.value, balanceOf[to]);
    }

    /// @notice ERC-20 credit (C3): pull `amount` of `token` from the authorized
    ///         caller (which must have approved the vault) and attribute it to
    ///         `to`. The token analogue of `credit` — same one-money-in path.
    function creditToken(address token, address to, uint256 amount) external {
        require(authorized[msg.sender], "not-authorized");
        require(to != address(0), "zero-addr");
        require(amount > 0, "zero-value");
        // Measure the actual delta so a fee-on-transfer token can't over-credit
        // (defensive; the accepted set is plain stablecoins).
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        tokenBalanceOf[token][to] += received;
        emit TokenCredited(token, to, msg.sender, received, tokenBalanceOf[token][to]);
    }

    /// @notice Pull full `token` balance to self.
    function withdrawToken(address token) external nonReentrant {
        _withdrawToken(token, msg.sender);
    }

    /// @notice Pull full `token` balance to a chosen recipient (cold wallet).
    function withdrawTokenTo(address token, address recipient) external nonReentrant {
        require(recipient != address(0), "zero-addr");
        _withdrawToken(token, recipient);
    }

    /// @notice Pull full balance to self.
    function withdraw() external nonReentrant {
        _withdraw(msg.sender);
    }

    /// @notice Pull full balance to a chosen recipient (cold wallet).
    function withdrawTo(address recipient) external nonReentrant {
        require(recipient != address(0), "zero-addr");
        _withdraw(recipient);
    }

    /// @notice Relay-submitted gasless withdrawal (F8, DATUM settleClaimsFor
    ///         shape). `account` signs an EIP-712 authorization off-chain; any
    ///         relay submits it, pays the gas, and keeps `withdrawFeeBps` of the
    ///         balance as reimbursement — so a driver pulls earnings with zero gas
    ///         held. The relay is `msg.sender`, so the fee reaches the actual
    ///         gas-payer (a plain forwarder couldn't identify it). Only the
    ///         balance owner can authorize; the signature is single-use per nonce.
    function withdrawFor(
        address account,
        address recipient,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        require(block.timestamp <= deadline, "expired");
        require(recipient != address(0), "zero-addr");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(WITHDRAW_TYPEHASH, account, recipient, withdrawNonce[account], deadline))
        );
        require(digest.recover(signature) == account, "bad-sig");
        withdrawNonce[account] += 1;

        uint256 amount = balanceOf[account];
        require(amount > 0, "zero-balance");
        balanceOf[account] = 0;

        uint256 fee = (amount * withdrawFeeBps) / 10_000;
        uint256 toRecipient = amount - fee;
        if (fee > 0) {
            // Re-attribute the fee to the relay's own vault balance (pull, not
            // push) — one money-out path, and totalWithdrawn tracks only what
            // actually leaves. The relay withdraws its accrued fees normally.
            balanceOf[msg.sender] += fee;
            emit RelayWithdrawFee(msg.sender, account, fee);
        }
        totalWithdrawn += toRecipient;
        emit Withdrawn(account, recipient, toRecipient);
        _safeSend(recipient, toRecipient);
    }

    function _withdraw(address recipient) internal {
        uint256 amount = balanceOf[msg.sender];
        require(amount > 0, "zero-balance");
        balanceOf[msg.sender] = 0;
        totalWithdrawn += amount;
        emit Withdrawn(msg.sender, recipient, amount);
        _safeSend(recipient, amount);
    }

    function _withdrawToken(address token, address recipient) internal {
        uint256 amount = tokenBalanceOf[token][msg.sender];
        require(amount > 0, "zero-balance");
        tokenBalanceOf[token][msg.sender] = 0;
        emit TokenWithdrawn(token, msg.sender, recipient, amount);
        IERC20(token).safeTransfer(recipient, amount);
    }
}
