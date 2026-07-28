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
    // There was a three-transaction KEEPER path here (queueShieldCredit →
    // sealShieldBatch → depositShieldBatch). It has been REMOVED, not deprecated.
    // Two reasons, both structural:
    //   - Its anonymity set was only the seal size, whereas the ZK note path
    //     below gets every unspent note in the tree.
    //   - The keeper held the account↔commitment pairing, so it could substitute
    //     its own commitments. That risk was dormant only because no keeper was
    //     authorized; a single `setShieldKeeper` call re-armed it. A privacy
    //     guarantee one owner transaction away from being void is not one.
    // The ZK path needs no keeper and is permissionless, so nothing is lost.
    IFareShieldPool public shieldPool; // address(0) = shielded payouts off
    uint96[] public shieldBuckets; // allowed denominations, ascending
    // Value moved out of balanceOf and held against un-deposited notes. Shared
    // accounting for the ZK path: insertShieldNote adds, depositShieldNoteZK
    // subtracts. (It backed the keeper tickets too, which is why it predates them.)
    uint256 public shieldBuffer;
    mapping(address => uint256) public shieldNonce; // separate from withdrawNonce

    // ── ZK note pool (privacy phase 3) — the ONLY shielding path ─────────────
    // A payee converts balance into a NOTE (linked, like
    // any pool deposit) and later spends it with a Groth16 proof that reveals
    // only a nullifier. Nothing says which note was spent, so the anonymity set
    // is every unspent note in the tree. And because the proof binds the
    // shielded-pool commitment, `depositShieldNoteZK` is PERMISSIONLESS: anyone
    // may submit it, nobody can redirect it. See circuits/shieldnote.circom.
    uint256 public constant NOTE_DEPTH = 16; // 65,536 notes; must match the circuit
    uint256 private constant ROOT_HISTORY = 30;

    IFareShieldVerifier public shieldVerifier; // address(0) = ZK path off
    IFarePoseidonT3 public shieldPoseidon;

    uint256[NOTE_DEPTH] public noteZeros; // empty-subtree roots, set with the hasher
    uint256[NOTE_DEPTH] private _filledSubtrees;
    uint256[ROOT_HISTORY] public noteRoots;
    uint32 public noteRootIndex;
    uint32 public nextNoteIndex;
    mapping(uint256 => bool) public shieldNullifierSpent;

    bytes32 private constant NOTE_TYPEHASH =
        keccak256("ShieldNote(address account,uint96 bucket,uint256 commitment,uint256 nonce,uint256 deadline)");

    event ShieldNoteInserted(address indexed account, uint96 indexed bucket, uint256 commitment, uint32 index);
    event ShieldNoteSpent(uint256 indexed nullifierHash, uint96 indexed bucket, bytes32 ksCommitment);
    event ShieldVerifierSet(address indexed verifier);
    event ShieldPoseidonSet(address indexed poseidon);

    event ShieldPoolSet(address indexed pool);
    event ShieldBucketsSet(uint96[] buckets);

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

    /// @notice Point at the shield-note Groth16 verifier. address(0) disables the
    ///         ZK path; the ticket path is unaffected either way.
    function setShieldVerifier(address verifier) external onlyOwner {
        shieldVerifier = IFareShieldVerifier(verifier);
        emit ShieldVerifierSet(verifier);
    }

    /// @notice Bind the Poseidon(2) hasher and initialize the note tree.
    /// @dev The zeros are derived from the hasher itself, so the tree cannot be
    ///      initialized against one Poseidon and used with another. Re-pointing
    ///      after notes exist would invalidate every outstanding proof, so this
    ///      is one-shot.
    function setShieldPoseidon(address poseidon) external onlyOwner {
        require(address(shieldPoseidon) == address(0), "poseidon-set");
        require(poseidon != address(0), "zero-addr");
        shieldPoseidon = IFarePoseidonT3(poseidon);

        uint256 z = 0;
        for (uint256 i = 0; i < NOTE_DEPTH; i++) {
            noteZeros[i] = z;
            _filledSubtrees[i] = z;
            z = _poseidon(z, z);
        }
        noteRoots[0] = z; // the empty tree's root
        emit ShieldPoseidonSet(poseidon);
    }

    /// @notice The current note-tree root.
    function noteRoot() public view returns (uint256) {
        return noteRoots[noteRootIndex];
    }

    /// @notice Is `root` within the retained window? Proofs are built off-chain
    ///         against a root that may be a few inserts stale by the time they
    ///         land, so a window is required for the path to be usable at all.
    function isKnownNoteRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = noteRootIndex;
        for (uint256 n = 0; n < ROOT_HISTORY; n++) {
            if (noteRoots[i] == root) return true;
            i = i == 0 ? uint32(ROOT_HISTORY - 1) : i - 1;
        }
        return false;
    }

    function shieldBucketCount() external view returns (uint256) {
        return shieldBuckets.length;
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

    // ── ZK note pool: insert → prove → deposit ───────────────────────────────

    /// @notice Convert `bucket` of your balance into a shielded note.
    /// @dev This transaction names you AND your note commitment, and that is
    ///      fine: the anonymity comes from spending, which reveals only a
    ///      nullifier. It is the same shape as any pool deposit.
    function insertShieldNote(uint96 bucket, uint256 commitment) external nonReentrant {
        _insertShieldNote(msg.sender, bucket, commitment);
    }

    /// @notice Relay-submitted note insertion, so a payee with no gas can shield
    ///         earnings.
    /// @dev The signature covers the COMMITMENT, so a relay cannot substitute a
    ///      note of its own — the one thing it could otherwise steal here.
    function insertShieldNoteFor(
        address account,
        uint96 bucket,
        uint256 commitment,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        require(block.timestamp <= deadline, "expired");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(NOTE_TYPEHASH, account, bucket, commitment, shieldNonce[account], deadline))
        );
        require(digest.recover(signature) == account, "bad-sig");
        shieldNonce[account] += 1;
        _insertShieldNote(account, bucket, commitment);
    }

    /// @notice Spend a note into the shielded pool. PERMISSIONLESS by design:
    ///         the proof binds `ksCommitment`, so whoever submits it cannot
    ///         redirect the deposit, and a payee needs no gas and no keeper.
    /// @dev Reveals a nullifier and nothing else — not the leaf, not the index,
    ///      not the account. The anonymity set is every unspent note.
    function depositShieldNoteZK(
        bytes calldata proof,
        uint256 root,
        uint256 nullifierHash,
        uint96 bucket,
        bytes32 ksCommitment
    ) external nonReentrant {
        require(address(shieldVerifier) != address(0), "zk-off");
        require(address(shieldPool) != address(0), "shield-off");
        require(!shieldNullifierSpent[nullifierHash], "note-spent");
        require(isKnownNoteRoot(root), "unknown-root");
        require(_isShieldBucket(bucket), "bad-bucket");
        require(
            shieldVerifier.verifyShieldNote(proof, [root, nullifierHash, uint256(bucket), uint256(ksCommitment)]),
            "bad-proof"
        );

        // Effects before the external call; the nullifier is burned even if the
        // pool reverts, and the whole call unwinds together if it does.
        shieldNullifierSpent[nullifierHash] = true;
        shieldBuffer -= bucket;
        emit ShieldNoteSpent(nullifierHash, bucket, ksCommitment);

        shieldPool.depositNative{value: bucket}(ksCommitment);
    }

    function _insertShieldNote(address account, uint96 bucket, uint256 commitment) internal {
        require(address(shieldPoseidon) != address(0), "poseidon-unset");
        require(_isShieldBucket(bucket), "bad-bucket");
        require(balanceOf[account] >= bucket, "insufficient-balance");
        require(commitment != 0, "zero-commitment");

        balanceOf[account] -= bucket;
        shieldBuffer += bucket;
        uint32 index = _insertLeaf(commitment);
        emit ShieldNoteInserted(account, bucket, commitment, index);
    }

    /// @dev Standard incremental Merkle insert: hash up the spine, caching the
    ///      left siblings that later leaves will need.
    function _insertLeaf(uint256 leaf) internal returns (uint32 index) {
        index = nextNoteIndex;
        require(index < uint32(1 << NOTE_DEPTH), "tree-full");

        uint256 current = leaf;
        uint32 idx = index;
        for (uint256 i = 0; i < NOTE_DEPTH; i++) {
            uint256 left;
            uint256 right;
            if (idx % 2 == 0) {
                left = current;
                right = noteZeros[i];
                _filledSubtrees[i] = current;
            } else {
                left = _filledSubtrees[i];
                right = current;
            }
            current = _poseidon(left, right);
            idx /= 2;
        }

        noteRootIndex = uint32((noteRootIndex + 1) % ROOT_HISTORY);
        noteRoots[noteRootIndex] = current;
        nextNoteIndex = index + 1;
    }

    function _poseidon(uint256 a, uint256 b) internal view returns (uint256) {
        return shieldPoseidon.hash([a, b]);
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
