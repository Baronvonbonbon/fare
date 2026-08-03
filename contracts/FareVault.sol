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
    uint256 public emptyNoteRoot; // root of a tree with no leaves, shared by every asset

    // ── one note tree PER ASSET, `address(0)` = native ───────────────────────
    // The circuit's public signals are [root, nullifierHash, bucket,
    // ksCommitment] — there is NO asset signal, and a spend reveals only the
    // nullifier, never the commitment, so the vault cannot look up which asset a
    // spent note was inserted for. Without binding, a note inserted for 1 USDC
    // could be spent against the native buffer for 1 PAS.
    //
    // Separate trees are the binding: `root` is already a public signal, so a
    // proof built against the USDC tree cannot satisfy the native root window
    // and vice versa. This needs NO circuit change and therefore no second
    // trusted setup — `setVerifyingKey` is lock-once and the existing
    // single-party ceremony is already the top mainnet blocker
    // (docs/PRIVACY-STATUS.md). The cost is that each asset's anonymity set is
    // its own tree, which the shielded pool's per-asset escrow implies anyway.
    struct NoteTree {
        uint256[ROOT_HISTORY] roots;
        uint256[NOTE_DEPTH] filledSubtrees;
        uint32 rootIndex;
        uint32 nextIndex;
        bool warmed; // packs with the two uint32s above — free
    }

    mapping(address => NoteTree) private _noteTrees;
    mapping(address => uint96[]) private _shieldBuckets; // asset => denominations, ascending
    // Value moved out of balanceOf/tokenBalanceOf and held against un-deposited
    // notes, per asset: insert adds, the ZK spend subtracts.
    mapping(address => uint256) private _shieldBuffer;
    mapping(address => mapping(uint256 => bool)) private _nullifierSpent;

    // Asset Hub asset id for an accepted ERC-20 (1337 = USDC). `depositAsset`
    // takes the ID while the escrow ledger and the note commitment key on the
    // precompile ADDRESS, so the two are set explicitly rather than derived —
    // a change in the precompile address scheme must not silently misroute.
    mapping(address => uint64) public shieldAssetId;

    bytes32 private constant NOTE_TYPEHASH =
        keccak256("ShieldNote(address account,uint96 bucket,uint256 commitment,uint256 nonce,uint256 deadline)");
    bytes32 private constant NOTE_TOKEN_TYPEHASH = keccak256(
        "ShieldNoteToken(address token,address account,uint96 bucket,uint256 commitment,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant WITHDRAW_TOKEN_TYPEHASH = keccak256(
        "WithdrawToken(address token,address account,address recipient,uint256 nonce,uint256 deadline)"
    );

    event ShieldNoteInserted(address indexed account, uint96 indexed bucket, uint256 commitment, uint32 index);
    event ShieldNoteSpent(uint256 indexed nullifierHash, uint96 indexed bucket, bytes32 ksCommitment);
    // Token variants index the ASSET FIRST and leave the rest unindexed on
    // purpose: Paseo's eth_getLogs rejects `null` topic placeholders and
    // mishandles the `[]` wildcard, so only a LEADING indexed param is
    // server-side filterable. Same reason FareOrders indexes `region` first.
    event ShieldNoteInsertedToken(
        address indexed token, address account, uint96 bucket, uint256 commitment, uint32 index
    );
    event ShieldNoteSpentToken(address indexed token, uint256 nullifierHash, uint96 bucket, bytes32 ksCommitment);
    event ShieldVerifierSet(address indexed verifier);
    event ShieldPoseidonSet(address indexed poseidon);

    event ShieldPoolSet(address indexed pool);
    event ShieldBucketsSet(uint96[] buckets);
    event ShieldBucketsTokenSet(address indexed token, uint96[] buckets);
    event ShieldAssetIdSet(address indexed token, uint64 assetId);

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
        _setShieldBuckets(address(0), buckets);
        emit ShieldBucketsSet(buckets);
    }

    /// @notice Set the allowed denominations for an ERC-20 asset's notes.
    /// @dev Deliberately does NOT apply the PaseoSafeSender rounding check the
    ///      native path uses. That bug is in the eth-rpc denomination conversion
    ///      for `msg.value`; an ERC-20 transfer never touches it. Applying it
    ///      here would reject legitimate 6-decimal rungs — 0.5 USDC is 500_000,
    ///      which fails `% 10**6 < 500_000` while being perfectly sendable.
    function setShieldBucketsToken(address token, uint96[] calldata buckets) external onlyOwner {
        require(token != address(0), "zero-addr");
        // A token note is unreachable until its ladder is set, so this is the
        // one call guaranteed to precede the first insert — the right place to
        // pre-pay the tree. Idempotent, so re-tuning a ladder costs nothing.
        require(address(shieldPoseidon) != address(0), "poseidon-unset");
        _setShieldBuckets(token, buckets);
        _warmTree(token);
        emit ShieldBucketsTokenSet(token, buckets);
    }

    /// @notice Bind an accepted ERC-20 to its Asset Hub asset id, so the vault
    ///         can call `depositAsset(id, …)` while everything else keys on the
    ///         precompile address. Required before that token can be shielded.
    function setShieldAssetId(address token, uint64 assetId) external onlyOwner {
        require(token != address(0), "zero-addr");
        shieldAssetId[token] = assetId;
        emit ShieldAssetIdSet(token, assetId);
    }

    function _setShieldBuckets(address asset, uint96[] calldata buckets) internal {
        require(buckets.length > 0, "no-buckets");
        for (uint256 i = 0; i < buckets.length; i++) {
            require(buckets[i] > 0, "zero-bucket");
            require(i == 0 || buckets[i] > buckets[i - 1], "not-ascending");
            if (asset == address(0)) {
                require(uint256(buckets[i]) % PASEO_UNIT < PASEO_REJECT_THRESHOLD, "bucket-unsendable");
            }
        }
        _shieldBuckets[asset] = buckets;
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
            z = _poseidon(z, z);
        }
        // Shared by every asset's tree — one hasher, one depth, one empty root.
        emptyNoteRoot = z;
        _warmTree(address(0));
        emit ShieldPoseidonSet(poseidon);
    }

    /// @dev Pre-pay a tree's storage. `filledSubtrees[i]` is always written by an
    ///      earlier left-child insert before any right child reads it, so these
    ///      values are never actually read — the write buys nothing semantically
    ///      and exists only to make the slots non-zero. Without it the FIRST
    ///      insert into a tree pays 16 cold zero→non-zero SSTOREs instead of
    ///      warm ones, ~280k extra gas. That is a setup cost, so governance pays
    ///      it here rather than charging it to whichever payee shields first.
    function _warmTree(address asset) internal {
        NoteTree storage t = _noteTrees[asset];
        if (t.warmed) return;
        for (uint256 i = 0; i < NOTE_DEPTH; i++) t.filledSubtrees[i] = noteZeros[i];
        t.roots[0] = emptyNoteRoot;
        t.warmed = true;
    }

    // ── note-tree views ──────────────────────────────────────────────────────
    // The native-asset accessors keep their exact pre-existing signatures:
    // web/src/abi.ts, venue-node/relay.mjs and the live scripts all read them.

    /// @notice The current note-tree root for `asset` (address(0) = native).
    function noteRootOf(address asset) public view returns (uint256) {
        NoteTree storage t = _noteTrees[asset];
        return t.nextIndex == 0 ? emptyNoteRoot : t.roots[t.rootIndex];
    }

    /// @notice The current native note-tree root.
    function noteRoot() external view returns (uint256) {
        return noteRootOf(address(0));
    }

    /// @notice Is `root` within `asset`'s retained window? Proofs are built
    ///         off-chain against a root that may be a few inserts stale by the
    ///         time they land, so a window is required for the path to be usable
    ///         at all. This is also what binds a note to its asset: a USDC-tree
    ///         root can never be known to the native tree.
    function isKnownNoteRootFor(address asset, uint256 root) public view returns (bool) {
        if (root == 0) return false;
        NoteTree storage t = _noteTrees[asset];
        if (t.nextIndex == 0) return root == emptyNoteRoot;
        uint32 i = t.rootIndex;
        for (uint256 n = 0; n < ROOT_HISTORY; n++) {
            if (t.roots[i] == root) return true;
            i = i == 0 ? uint32(ROOT_HISTORY - 1) : i - 1;
        }
        return false;
    }

    function isKnownNoteRoot(uint256 root) external view returns (bool) {
        return isKnownNoteRootFor(address(0), root);
    }

    function noteIndexOf(address asset) public view returns (uint32) {
        return _noteTrees[asset].nextIndex;
    }

    function nextNoteIndex() external view returns (uint32) {
        return _noteTrees[address(0)].nextIndex;
    }

    function shieldBufferOf(address asset) public view returns (uint256) {
        return _shieldBuffer[asset];
    }

    function shieldBuffer() external view returns (uint256) {
        return _shieldBuffer[address(0)];
    }

    function nullifierSpentOf(address asset, uint256 nullifierHash) public view returns (bool) {
        return _nullifierSpent[asset][nullifierHash];
    }

    function shieldNullifierSpent(uint256 nullifierHash) external view returns (bool) {
        return _nullifierSpent[address(0)][nullifierHash];
    }

    function shieldBuckets(uint256 i) external view returns (uint96) {
        return _shieldBuckets[address(0)][i];
    }

    function shieldBucketCount() external view returns (uint256) {
        return _shieldBuckets[address(0)].length;
    }

    function shieldBucketsToken(address token, uint256 i) external view returns (uint96) {
        return _shieldBuckets[token][i];
    }

    function shieldBucketCountToken(address token) external view returns (uint256) {
        return _shieldBuckets[token].length;
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

    /// @notice Relay-submitted gasless ERC-20 withdrawal — the token analogue of
    ///         `withdrawFor`, which only ever covered native.
    /// @dev This is the PUBLIC exit, kept for the residue a denomination ladder
    ///      always leaves below its smallest rung. It names the account and the
    ///      recipient; the private exit is insertShieldNoteToken →
    ///      depositShieldNoteTokenZK. Distinct typehash from the native
    ///      `Withdraw`, so neither signature can stand in for the other.
    function withdrawForToken(
        address token,
        address account,
        address recipient,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        require(block.timestamp <= deadline, "expired");
        require(recipient != address(0), "zero-addr");
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(WITHDRAW_TOKEN_TYPEHASH, token, account, recipient, withdrawNonce[account], deadline)
            )
        );
        require(digest.recover(signature) == account, "bad-sig");
        withdrawNonce[account] += 1;

        uint256 amount = tokenBalanceOf[token][account];
        require(amount > 0, "zero-balance");
        tokenBalanceOf[token][account] = 0;

        uint256 fee = (amount * withdrawFeeBps) / 10_000;
        uint256 toRecipient = amount - fee;
        if (fee > 0) {
            // Same shape as the native path: the fee becomes the relay's own
            // vault balance rather than a push, so there is still one money-out.
            tokenBalanceOf[token][msg.sender] += fee;
            emit RelayWithdrawFee(msg.sender, account, fee);
        }
        emit TokenWithdrawn(token, account, recipient, toRecipient);
        IERC20(token).safeTransfer(recipient, toRecipient);
    }

    // ── ZK note pool: insert → prove → deposit ───────────────────────────────

    /// @notice Convert `bucket` of your balance into a shielded note.
    /// @dev This transaction names you AND your note commitment, and that is
    ///      fine: the anonymity comes from spending, which reveals only a
    ///      nullifier. It is the same shape as any pool deposit.
    function insertShieldNote(uint96 bucket, uint256 commitment) external nonReentrant {
        _insertShieldNote(address(0), msg.sender, bucket, commitment);
    }

    /// @notice Convert `bucket` of your `token` balance into a shielded note.
    ///         The stablecoin analogue of `insertShieldNote` — without it a
    ///         payee settled in USDC has no private exit at all, only
    ///         `withdrawToken` to a named address.
    function insertShieldNoteToken(address token, uint96 bucket, uint256 commitment) external nonReentrant {
        require(token != address(0), "zero-addr");
        _insertShieldNote(token, msg.sender, bucket, commitment);
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
        _insertShieldNote(address(0), account, bucket, commitment);
    }

    /// @notice Relay-submitted token note insertion.
    /// @dev A DISTINCT typehash ("ShieldNoteToken", and it carries `token`), so
    ///      a signature authorizing a native insert can never be replayed as a
    ///      token insert. The shared `shieldNonce` still makes each single-use.
    function insertShieldNoteTokenFor(
        address token,
        address account,
        uint96 bucket,
        uint256 commitment,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        require(token != address(0), "zero-addr");
        require(block.timestamp <= deadline, "expired");
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(NOTE_TOKEN_TYPEHASH, token, account, bucket, commitment, shieldNonce[account], deadline)
            )
        );
        require(digest.recover(signature) == account, "bad-sig");
        shieldNonce[account] += 1;
        _insertShieldNote(token, account, bucket, commitment);
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
        _verifyAndBurn(address(0), proof, root, nullifierHash, bucket, ksCommitment);
        emit ShieldNoteSpent(nullifierHash, bucket, ksCommitment);
        shieldPool.depositNative{value: bucket}(ksCommitment);
    }

    /// @notice Spend a TOKEN note into the shielded pool. Permissionless on the
    ///         same terms as the native path — the proof binds `ksCommitment`.
    /// @dev The asset binding is `root`: `_verifyAndBurn` checks the root against
    ///      `token`'s own tree, so a proof built over the native tree (or any
    ///      other token's) fails "unknown-root" before the verifier is reached.
    function depositShieldNoteTokenZK(
        bytes calldata proof,
        uint256 root,
        uint256 nullifierHash,
        address token,
        uint96 bucket,
        bytes32 ksCommitment
    ) external nonReentrant {
        require(token != address(0), "zero-addr");
        uint64 assetId = shieldAssetId[token];
        require(assetId != 0, "asset-unset");

        _verifyAndBurn(token, proof, root, nullifierHash, bucket, ksCommitment);
        emit ShieldNoteSpentToken(token, nullifierHash, bucket, ksCommitment);

        // The pool pulls via transferFrom, so it needs an allowance — bounded to
        // exactly this bucket. A MaxUint256 approval REVERTS on the Asset Hub
        // ERC-20 precompile ("Balance conversion failed"): it narrows to
        // pallet-assets' u128.
        IERC20(token).forceApprove(address(shieldPool), bucket);
        shieldPool.depositAsset(uint256(assetId), bucket, ksCommitment);
    }

    /// @dev The shared half of both spends: every check, then the state effects,
    ///      leaving only the pool call to the caller. Effects land before that
    ///      external call — the nullifier is burned even if the pool reverts,
    ///      and the whole call unwinds together if it does.
    function _verifyAndBurn(
        address asset,
        bytes calldata proof,
        uint256 root,
        uint256 nullifierHash,
        uint96 bucket,
        bytes32 ksCommitment
    ) internal {
        require(address(shieldVerifier) != address(0), "zk-off");
        require(address(shieldPool) != address(0), "shield-off");
        require(!_nullifierSpent[asset][nullifierHash], "note-spent");
        require(isKnownNoteRootFor(asset, root), "unknown-root");
        require(_isShieldBucket(asset, bucket), "bad-bucket");
        require(
            shieldVerifier.verifyShieldNote(proof, [root, nullifierHash, uint256(bucket), uint256(ksCommitment)]),
            "bad-proof"
        );

        _nullifierSpent[asset][nullifierHash] = true;
        _shieldBuffer[asset] -= bucket;
    }

    function _insertShieldNote(address asset, address account, uint96 bucket, uint256 commitment) internal {
        require(address(shieldPoseidon) != address(0), "poseidon-unset");
        require(_isShieldBucket(asset, bucket), "bad-bucket");
        require(commitment != 0, "zero-commitment");

        if (asset == address(0)) {
            require(balanceOf[account] >= bucket, "insufficient-balance");
            balanceOf[account] -= bucket;
        } else {
            require(tokenBalanceOf[asset][account] >= bucket, "insufficient-balance");
            tokenBalanceOf[asset][account] -= bucket;
        }
        _shieldBuffer[asset] += bucket;

        uint32 index = _insertLeaf(asset, commitment);
        if (asset == address(0)) {
            emit ShieldNoteInserted(account, bucket, commitment, index);
        } else {
            emit ShieldNoteInsertedToken(asset, account, bucket, commitment, index);
        }
    }

    /// @dev Standard incremental Merkle insert: hash up the spine, caching the
    ///      left siblings that later leaves will need.
    function _insertLeaf(address asset, uint256 leaf) internal returns (uint32 index) {
        NoteTree storage t = _noteTrees[asset];
        index = t.nextIndex;
        require(index < uint32(1 << NOTE_DEPTH), "tree-full");

        uint256 current = leaf;
        uint32 idx = index;
        for (uint256 i = 0; i < NOTE_DEPTH; i++) {
            uint256 left;
            uint256 right;
            if (idx % 2 == 0) {
                left = current;
                right = noteZeros[i];
                t.filledSubtrees[i] = current;
            } else {
                left = t.filledSubtrees[i];
                right = current;
            }
            current = _poseidon(left, right);
            idx /= 2;
        }

        t.rootIndex = uint32((t.rootIndex + 1) % ROOT_HISTORY);
        t.roots[t.rootIndex] = current;
        t.nextIndex = index + 1;
    }

    function _poseidon(uint256 a, uint256 b) internal view returns (uint256) {
        return shieldPoseidon.hash([a, b]);
    }

    function _isShieldBucket(address asset, uint96 bucket) internal view returns (bool) {
        uint96[] storage b = _shieldBuckets[asset];
        for (uint256 i = 0; i < b.length; i++) if (b[i] == bucket) return true;
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
