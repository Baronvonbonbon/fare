// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./lib/PaseoSafeSender.sol";
import "./lib/FareUpgradable.sol";
import "./interfaces/IFare.sol";

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

    // ── shielded payouts (privacy phase 1) ───────────────────────────────────
    // Drivers and venues are paid at persistent addresses, so `Withdrawn` builds
    // a permanent revenue graph. Routing a payout into the Kusama Shield pool
    // fixes that ONLY if the account and the pool commitment never appear
    // together: a one-transaction withdrawToShield(commitment) emits both in the
    // same receipt and the note is attributable before it is ever spent. See
    // docs/PRIVACY-TIERS.md §3.
    //
    // So the payout is split in two, sharing no identity:
    //   T1 queueShieldCredit — moves a FIXED bucket from balanceOf into the
    //      shared buffer and takes a ticket. Public: (account, bucket). No
    //      commitment exists on-chain yet.
    //   T2 sealShieldBatch — a keeper consumes the N oldest tickets FIFO
    //      (N >= minBatch), naming no commitment. Public: N accounts served.
    //   T3 depositShieldBatch — the keeper deposits commitments against sealed
    //      tickets, naming no account and no ticket. Public: the commitments.
    //
    // T2 and T3 are separate because merging them made the number of deposits a
    // transaction can hold the anonymity set — 2 on Paseo. Split, the anonymity
    // set is the SEAL size (docs/E2E-PRIVACY-LIVE.md §2).
    //
    // Pairing T1 with T2 means guessing which of the N commitments is whose, so
    // the anonymity set is the batch on top of the pool's own. Bucketing is
    // load-bearing: without fixed denominations the amounts re-identify the
    // entries and the batch is decorative.
    IFareShieldPool public shieldPool; // address(0) = shielded payouts off
    uint96[] public shieldBuckets; // allowed denominations, ascending
    uint16 public shieldMinBatch = 8; // refuse batches small enough to be linkable
    uint32 public shieldMinDwell = 5 minutes; // a ticket must age before it can be batched
    uint32 public shieldReclaimAfter = 24 hours; // liveness escape hatch if keepers stall
    uint256 public shieldBuffer; // native value held against unconsumed tickets
    mapping(address => bool) public shieldKeeper;
    mapping(address => uint256) public shieldNonce; // separate from withdrawNonce

    /// A queued bucket awaiting deposit. `owner` is only ever paired with the
    /// bucket and a queue position — never with a commitment — so publishing it
    /// leaks nothing the T1 event doesn't already. It buys a self-service
    /// reclaim, which a fungible slot could not offer.
    struct ShieldTicket {
        address owner;
        uint64 queuedAt;
        bool reclaimed;
    }
    mapping(uint96 => mapping(uint64 => ShieldTicket)) public shieldTicket; // bucket => ticket# => ticket
    mapping(uint96 => uint64) public shieldQueued; // bucket => tickets ever taken
    mapping(uint96 => uint64) public shieldScanned; // bucket => FIFO cursor (sealed + skipped)
    mapping(uint96 => uint64) public shieldLive; // bucket => tickets awaiting a seal
    mapping(uint96 => uint64) public shieldSealed; // bucket => deposits owed, no longer tied to a ticket

    bytes32 private constant SHIELD_TYPEHASH =
        keccak256("ShieldCredit(address account,uint96 bucket,uint256 nonce,uint256 deadline)");

    event ShieldQueued(address indexed account, uint96 indexed bucket, uint64 ticket);
    event ShieldBatchSealed(address indexed keeper, uint96 indexed bucket, uint64 count, uint64 firstTicket);
    event ShieldDeposited(address indexed keeper, uint96 indexed bucket, uint64 count);
    event ShieldReclaimed(address indexed account, uint96 indexed bucket, uint64 ticket);
    event ShieldPoolSet(address indexed pool);
    event ShieldBucketsSet(uint96[] buckets);
    event ShieldParamsSet(uint16 minBatch, uint32 minDwell, uint32 reclaimAfter);
    event ShieldKeeperSet(address indexed keeper, bool enabled);

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

    // ── shielded-payout governance ───────────────────────────────────────────

    /// @notice Point at the external shielded pool. address(0) disables the
    ///         feature (the default); queued tickets stay reclaimable either way.
    function setShieldPool(address pool) external onlyOwner {
        shieldPool = IFareShieldPool(pool);
        emit ShieldPoolSet(pool);
    }

    /// @notice Set the allowed deposit denominations, ascending. Every payout is
    ///         shielded as a sum of these, so the on-chain amounts carry no
    ///         per-driver signal. Callers keep any remainder as a normal balance.
    /// @dev Buckets must clear the Paseo eth-rpc rounding bug (PaseoSafeSender)
    ///      or every deposit in that denomination would revert at submission.
    function setShieldBuckets(uint96[] calldata buckets) external onlyOwner {
        require(buckets.length > 0, "no-buckets");
        for (uint256 i = 0; i < buckets.length; i++) {
            require(buckets[i] > 0, "zero-bucket");
            require(i == 0 || buckets[i] > buckets[i - 1], "not-ascending");
            require(uint256(buckets[i]) % PASEO_UNIT < PASEO_REJECT_THRESHOLD, "bucket-unsendable");
        }
        shieldBuckets = buckets;
        emit ShieldBucketsSet(buckets);
    }

    /// @notice Batch-privacy parameters. `minBatch` is the anonymity set a
    ///         single batch provides — 1 would reproduce the linkable
    ///         one-transaction design, so it is floored at 2. `minDwell` stops a
    ///         keeper executing a batch the instant a ticket lands (which would
    ///         re-link it by timing). `reclaimAfter` bounds how long a stalled
    ///         queue can hold funds.
    function setShieldParams(uint16 minBatch, uint32 minDwell, uint32 reclaimAfter) external onlyOwner {
        require(minBatch >= 2, "batch-too-small");
        require(reclaimAfter >= minDwell, "reclaim-before-dwell");
        shieldMinBatch = minBatch;
        shieldMinDwell = minDwell;
        shieldReclaimAfter = reclaimAfter;
        emit ShieldParamsSet(minBatch, minDwell, reclaimAfter);
    }

    /// @notice Authorize a batch executor (a venue-node relay acting as keeper).
    /// @dev A keeper that queued a ticket knows which commitment it belongs to,
    ///      so this closes the chain-observer leak, not the keeper itself.
    ///      Blinding the keeper needs the phase-3 ZK authorization.
    function setShieldKeeper(address keeper, bool enabled) external onlyOwner {
        require(keeper != address(0), "zero-addr");
        shieldKeeper[keeper] = enabled;
        emit ShieldKeeperSet(keeper, enabled);
    }

    function shieldBucketCount() external view returns (uint256) {
        return shieldBuckets.length;
    }

    /// @notice Tickets queued but not yet sealed or reclaimed, for `bucket`.
    function shieldPending(uint96 bucket) public view returns (uint64) {
        return shieldLive[bucket];
    }

    /// @notice Deposits owed against sealed tickets — value the buffer still
    ///         holds but no ticket can reclaim.
    function shieldOwed(uint96 bucket) external view returns (uint64) {
        return shieldSealed[bucket];
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

    // ── shielded payouts: queue → batch → deposit ────────────────────────────

    /// @notice Move `bucket` of your own balance into the shield buffer and take
    ///         a ticket. Your commitment is NOT named here — you hand it to a
    ///         keeper off-chain, which deposits it in a batch alongside others.
    function queueShieldCredit(uint96 bucket) external nonReentrant {
        _queueShieldCredit(msg.sender, bucket);
    }

    /// @notice Relay-submitted queueing, so a driver with no gas can shield
    ///         earnings. Same EIP-712 shape as `withdrawFor`, separate nonce so
    ///         queueing never invalidates a pending withdrawal authorization.
    function queueShieldCreditFor(
        address account,
        uint96 bucket,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        require(block.timestamp <= deadline, "expired");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(SHIELD_TYPEHASH, account, bucket, shieldNonce[account], deadline))
        );
        require(digest.recover(signature) == account, "bad-sig");
        shieldNonce[account] += 1;
        _queueShieldCredit(account, bucket);
    }

    /// @notice Keeper: deposit `commitments` into the shielded pool, consuming
    ///         the oldest tickets of `bucket` FIFO — WITHOUT naming a single
    ///         commitment. Deposits happen separately (`depositShieldBatch`).
    ///
    /// @dev The split is the phase-2 fix, and it is not an optimization. Sealing
    ///      and depositing in one transaction made the number of deposits that
    ///      fit in a transaction the anonymity set, because an observer reads
    ///      `shieldScanned` before and after and learns exactly which accounts'
    ///      tickets those commitments belong to. Paseo caps a transaction at TWO
    ///      pool deposits — a proof-size bound, not gas — so that ceiling was
    ///      capping privacy at 2-anonymity (docs/E2E-PRIVACY-LIVE.md §2).
    ///
    ///      Sealing touches no external contract, so it is cheap and can consume
    ///      a large batch. The deposits that follow reference no ticket at all,
    ///      so nothing aligns a commitment with an account: the anonymity set is
    ///      the SEAL size, and the chain's per-transaction limit only decides how
    ///      many transactions the deposits take.
    function sealShieldBatch(uint96 bucket, uint64 count) external nonReentrant {
        require(shieldKeeper[msg.sender], "not-keeper");
        require(address(shieldPool) != address(0), "shield-off");
        require(count >= shieldMinBatch, "batch-too-small");
        require(shieldLive[bucket] >= count, "not-enough-tickets");

        // Walk the FIFO cursor forward over `count` live tickets, stepping past
        // any that were reclaimed while queued. Skipping is paid once — the
        // cursor stays advanced — so a burst of reclaims can't wedge the queue.
        uint64 first = shieldScanned[bucket];
        uint64 idx = first;
        uint64 taken = 0;
        while (taken < count) {
            ShieldTicket storage t = shieldTicket[bucket][idx];
            if (!t.reclaimed) {
                require(t.queuedAt + shieldMinDwell <= block.timestamp, "dwell-not-met");
                taken++;
            }
            idx++;
        }

        shieldScanned[bucket] = idx;
        shieldLive[bucket] -= count;
        shieldSealed[bucket] += count;
        emit ShieldBatchSealed(msg.sender, bucket, count, first);
    }

    /// @notice Keeper: deposit commitments against already-sealed tickets. Names
    ///         no account and no ticket — the only two things that could pair a
    ///         commitment with a payee.
    /// @dev Deliberately NOT floored by `shieldMinBatch`: a single deposit here
    ///      discloses nothing, because the accounts were sealed in a separate
    ///      transaction covering a much larger set. The caller sizes each call to
    ///      whatever the chain accepts (two, on Paseo).
    function depositShieldBatch(uint96 bucket, bytes32[] calldata commitments) external nonReentrant {
        require(shieldKeeper[msg.sender], "not-keeper");
        require(address(shieldPool) != address(0), "shield-off");
        uint64 n = uint64(commitments.length);
        require(n > 0, "empty-batch");
        require(shieldSealed[bucket] >= n, "not-sealed");

        // Effects before the external calls; the whole call unwinds together if a
        // single deposit reverts.
        shieldSealed[bucket] -= n;
        shieldBuffer -= uint256(bucket) * n;
        emit ShieldDeposited(msg.sender, bucket, n);

        for (uint256 i = 0; i < commitments.length; i++) {
            shieldPool.depositNative{value: bucket}(commitments[i]);
        }
    }

    /// @notice Liveness escape hatch: if no keeper has reached your ticket after
    ///         `shieldReclaimAfter`, take the value back as a normal balance.
    /// @dev Only a ticket the FIFO cursor has not passed can be reclaimed —
    ///      `ticket >= shieldScanned` is exactly "no deposit was made against
    ///      this one". Marking rather than removing keeps every other ticket at
    ///      its index, so no owner is ever displaced out of their claim.
    ///      Reclaiming publishes nothing new: the ticket already carried the
    ///      owner, and no commitment was ever attached to it.
    function reclaimShieldTicket(uint96 bucket, uint64 ticket) external nonReentrant {
        ShieldTicket storage t = shieldTicket[bucket][ticket];
        require(t.owner == msg.sender, "not-owner");
        require(!t.reclaimed, "already-reclaimed");
        require(ticket >= shieldScanned[bucket], "already-deposited");
        require(t.queuedAt + shieldReclaimAfter <= block.timestamp, "too-early");

        t.reclaimed = true;
        shieldLive[bucket] -= 1;
        shieldBuffer -= bucket;
        balanceOf[msg.sender] += bucket;
        emit ShieldReclaimed(msg.sender, bucket, ticket);
    }

    function _queueShieldCredit(address account, uint96 bucket) internal {
        require(address(shieldPool) != address(0), "shield-off");
        require(_isShieldBucket(bucket), "bad-bucket");
        require(balanceOf[account] >= bucket, "insufficient-balance");

        balanceOf[account] -= bucket;
        shieldBuffer += bucket;
        uint64 ticket = shieldQueued[bucket];
        shieldTicket[bucket][ticket] =
            ShieldTicket({owner: account, queuedAt: uint64(block.timestamp), reclaimed: false});
        shieldQueued[bucket] = ticket + 1;
        shieldLive[bucket] += 1;
        emit ShieldQueued(account, bucket, ticket);
    }

    function _isShieldBucket(uint96 bucket) internal view returns (bool) {
        for (uint256 i = 0; i < shieldBuckets.length; i++) if (shieldBuckets[i] == bucket) return true;
        return false;
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
