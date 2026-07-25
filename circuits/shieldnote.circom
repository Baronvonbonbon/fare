pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";

/// @title ShieldNote
/// @notice FARE privacy phase 3. Proves ownership of an unspent vault note
///         WITHOUT revealing which one, and binds the shielded-pool commitment
///         the resulting deposit must use.
///
/// Why this exists (docs/PRIVACY-TIERS.md §7, E2E-PRIVACY-LIVE.md §2). Phase 2
/// split sealing from depositing, so a deposit no longer names an account — but
/// a *seal* still does, which left the anonymity set equal to the seal size. And
/// the keeper still held the account↔commitment pairing, so it could substitute
/// its own commitments and keep the notes.
///
/// This closes both, because the proof itself is the authorization:
///   • Anonymity set = every unspent note in the tree, not one batch. Spending
///     reveals a nullifier, never a leaf index or an account.
///   • `ksCommitment` is a PUBLIC INPUT, so the deposit target is baked into the
///     proof. A keeper (or anyone else — the call is permissionless) cannot
///     redirect it, which removes the custody concession entirely.
///
/// Public signals (order fixed — matches IFareShieldVerifier / the vault):
///   [0] root           — a recent vault note-tree root (contract checks the window)
///   [1] nullifierHash  — Poseidon(nullifier); the spent-set key
///   [2] bucket         — denomination, bound into the leaf so a 1 PAS note
///                        cannot be spent as 25
///   [3] ksCommitment   — the Kusama Shield commitment this deposit must fund
///
/// Private witnesses:
///   nullifier, secret        — the note
///   pathElements, pathIndices — Merkle authentication path
///
/// Leaf: commitment = Poseidon(Poseidon(nullifier, secret), bucket)

template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component hashers[depth];
    component mux[depth];
    signal levelHash[depth + 1];
    levelHash[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        // pathIndices[i] must be a bit, or a prover could mix left/right freely
        // and forge a path.
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        hashers[i] = Poseidon(2);
        // index 0 → (current, sibling); index 1 → (sibling, current)
        hashers[i].inputs[0] <== levelHash[i] + pathIndices[i] * (pathElements[i] - levelHash[i]);
        hashers[i].inputs[1] <== pathElements[i] + pathIndices[i] * (levelHash[i] - pathElements[i]);
        levelHash[i + 1] <== hashers[i].out;
    }
    root <== levelHash[depth];
}

template ShieldNote(depth) {
    // public
    signal input root;
    signal input nullifierHash;
    signal input bucket;
    signal input ksCommitment;
    // private
    signal input nullifier;
    signal input secret;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // 1. The nullifier hash the contract will mark spent.
    component nh = Poseidon(1);
    nh.inputs[0] <== nullifier;
    nh.out === nullifierHash;

    // 2. The leaf: the note, with its denomination bound in.
    component inner = Poseidon(2);
    inner.inputs[0] <== nullifier;
    inner.inputs[1] <== secret;

    component leaf = Poseidon(2);
    leaf.inputs[0] <== inner.out;
    leaf.inputs[1] <== bucket;

    // 3. Membership: the leaf is in the tree with this root.
    component path = MerkleProof(depth);
    path.leaf <== leaf.out;
    for (var i = 0; i < depth; i++) {
        path.pathElements[i] <== pathElements[i];
        path.pathIndices[i] <== pathIndices[i];
    }
    path.root === root;

    // 4. Bind the deposit target. `ksCommitment` takes no part in the
    //    computation, so without a constraint referencing it the optimizer would
    //    drop it from the R1CS and anyone could re-point a valid proof at their
    //    own commitment. Squaring it is the cheapest way to make the proof
    //    depend on the exact value.
    signal ksSquare;
    ksSquare <== ksCommitment * ksCommitment;
}

component main {public [root, nullifierHash, bucket, ksCommitment]} = ShieldNote(16);
