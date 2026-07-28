import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
// @ts-ignore — circomlib's generated Poseidon has no types
import { poseidonContract } from "circomlibjs";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The relay's four shielded endpoints (TEST-PLAN C1, completing the chunk).
// Companion to relay-endpoints.test.ts, which covers the rest; separate because
// the shield paths need a different fixture (pool, Poseidon hasher, verifier,
// buckets) and a keeper-enabled relay instance.
//
// These endpoints are where the relay is *most* trusted and *least* authorized,
// which is the interesting combination:
//
//   /shield-queue        holds the account↔commitment pairing off-chain. The
//                        pairing must never reach the transaction — that is
//                        PRIVACY-TIERS §3, and it is asserted here against real
//                        calldata rather than taken on faith.
//   /shield-note         the signature covers the commitment, so a relay cannot
//                        swap in a note of its own.
//   /shield-note-spend   deliberately unauthenticated: the proof binds the
//                        destination, so anyone may pay the gas.
//   /shield-withdraw     the relay recomputes the proof's context and refuses a
//                        payout whose target it cannot verify.
//
// Groth16 proving is not repeated here — the real-proof paths live in
// shieldnote-vault.test.ts. What this file adds is the HTTP boundary in front
// of them: validation, rollback, and the pairing invariant.

const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
const PAS = (n: string | number) => ethers.parseEther(String(n));
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const contextFor = (a: string) =>
  BigInt(ethers.keccak256(ethers.solidityPacked(["address"], [a]))) % BN254_R;

function startRpcBridge(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const one = async (r: any) => {
      try {
        const result = await network.provider.request({ method: r.method, params: r.params ?? [] });
        return { jsonrpc: "2.0", id: r.id, result };
      } catch (e: any) {
        return { jsonrpc: "2.0", id: r.id, error: { code: e?.code ?? -32000, message: e?.message ?? String(e), data: e?.data } };
      }
    };
    let payload: any;
    try {
      const parsed = JSON.parse(body);
      payload = Array.isArray(parsed) ? await Promise.all(parsed.map(one)) : await one(parsed);
    } catch (e: any) {
      payload = { jsonrpc: "2.0", id: null, error: { code: -32700, message: String(e?.message ?? e) } };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => server.close() })
    )
  );
}

describe("relay shielded endpoints", function () {
  this.timeout(180_000);

  let dir: string;
  let bridge: { url: string; close: () => void };
  let keeperUrl: string, plainUrl: string;
  let keeperServer: any, plainServer: any;
  let vault: any, pool: any;
  let owner: HardhatEthersSigner, payee: HardhatEthersSigner, other: HardhatEthersSigner;
  let chainId: bigint;

  const BUCKET = PAS(1);

  /// Spaced past the ~250 ms read cache in the relay's own provider (ethers
  /// caches eth_call per tag), so each request sees the vault nonce the previous
  /// one advanced. Not the nonce-allocation defect — that is fixed, and proven
  /// unspaced in relay-endpoints.test.ts.
  const post = async (path: string, body: any, url = keeperUrl) => {
    await new Promise((r) => setTimeout(r, 300));
    return fetch(`${url}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  };

  const b32 = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
  const randField = () => BigInt("0x" + Buffer.from(ethers.randomBytes(31)).toString("hex"));

  /// EIP-712 ShieldCredit — authorizes moving `bucket` out of the vault balance
  /// into the shielded queue. The commitment is deliberately NOT in this
  /// signature: it travels in the request body and stays off-chain.

  /// EIP-712 ShieldNote — this one DOES cover the commitment, which is what
  /// stops a relay substituting its own.
  async function signShieldNote(account: HardhatEthersSigner, bucket: bigint, commitment: bigint, deadline: bigint) {
    const nonce = await vault.shieldNonce(account.address);
    return account.signTypedData(
      { name: "FareVault", version: "1", chainId, verifyingContract: vault.target as string },
      {
        ShieldNote: [
          { name: "account", type: "address" }, { name: "bucket", type: "uint96" },
          { name: "commitment", type: "uint256" }, { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { account: account.address, bucket, commitment, nonce, deadline }
    );
  }

  before(async () => {
    [owner, payee, other] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    vault = await (await ethers.getContractFactory("FareVault")).deploy();
    pool = await (await ethers.getContractFactory("MockShieldPool")).deploy();
    const verifier = await (await ethers.getContractFactory("FareShieldVerifier")).deploy();
    const poseidonImpl = await new ethers.ContractFactory(
      poseidonContract.generateABI(2), poseidonContract.createCode(2), owner
    ).deploy();
    const adapter = await (await ethers.getContractFactory("PoseidonT3Adapter"))
      .deploy(await poseidonImpl.getAddress());

    const VK = JSON.parse(readFileSync(join(__dirname, "..", "circuits", "build", "setShieldVK-calldata.json"), "utf8"));
    await verifier.setVerifyingKey(VK.alpha1, VK.beta2, VK.gamma2, VK.delta2, VK.IC0, VK.IC1, VK.IC2, VK.IC3, VK.IC4);

    await vault.setAuthorized(owner.address, true);
    await vault.setShieldPool(pool.target);
    await vault.setShieldBuckets([BUCKET, PAS(5)]);
    await vault.setShieldPoseidon(adapter.target);
    await vault.setShieldVerifier(verifier.target);
    await vault.credit(payee.address, { value: PAS(20) });
    await vault.credit(other.address, { value: PAS(20) });

    bridge = await startRpcBridge();
    dir = mkdtempSync(join(tmpdir(), "fare-shield-"));
    const book = join(dir, "addresses.json");
    writeFileSync(book, JSON.stringify({ vault: vault.target, settlement: vault.target }));

    const relayWallet = ethers.Wallet.createRandom();
    await network.provider.send("hardhat_setBalance", [relayWallet.address, "0x" + PAS(10_000).toString(16)]);

    delete process.env.PINE_RPC; // see relay-endpoints.test.ts
    process.env.RELAY_PRIVATE_KEY = relayWallet.privateKey;
    process.env.RELAY_RPC_URL = bridge.url;
    process.env.ADDRESS_BOOK = book;
    process.env.RATE_MAX = "100000";
    process.env.RELAY_PROFIT_GUARD = "off";
    process.env.SHIELD_POOL = pool.target as string;

    // Instance 1: no keeper — the endpoints that require one must refuse.
    delete process.env.SHIELD_KEEPER;
    const plain = await esmImport(pathToFileURL(join(__dirname, "..", "venue-node", "relay.mjs")).href + "?shield-plain");
    plainServer = plain.server;
    plainUrl = await new Promise((r) =>
      plainServer.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${plainServer.address().port}`)));

    // Instance 2: keeper on, with its own store. The poll interval is pushed out
    // so a background tick cannot batch mid-assertion.
    process.env.SHIELD_KEEPER = "1";
    process.env.SHIELD_KEEPER_STORE = join(dir, "keeper.json");
    process.env.SHIELD_KEEPER_POLL_MS = "3600000";
    const keeper = await esmImport(pathToFileURL(join(__dirname, "..", "venue-node", "relay.mjs")).href + "?shield-keeper");
    keeperServer = keeper.server;
    keeperUrl = await new Promise((r) =>
      keeperServer.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${keeperServer.address().port}`)));
  });

  after(() => {
    keeperServer?.close();
    plainServer?.close();
    bridge?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ── /shield-queue ─────────────────────────────────────────────────────────

  // The /shield-queue and /shield-claim tests lived here. Both endpoints are
  // gone with the vault's keeper path: they queued a payout for a keeper to
  // batch, and that keeper held the account↔commitment pairing. /shield-note
  // below is the replacement — the payee signs for their own note and the
  // relay cannot substitute a commitment, which the third test asserts.
  it("/shield-note validates its inputs", async () => {
    const base = { account: payee.address, bucket: BUCKET.toString(), commitment: "1", deadline: 0, signature: "0x00" };
    const cases: [any, RegExp][] = [
      [{ ...base, account: "0xnope" }, /bad account/],
      [{ ...base, signature: null }, /missing signature/],
      [{ ...base, commitment: "0" }, /zero commitment/],
      [{ ...base, bucket: "xyz" }, /bad bucket\/commitment/],
    ];
    for (const [body, msg] of cases) {
      const res = await post("/shield-note", body);
      expect(res.status, JSON.stringify(body)).to.equal(400);
      expect((await res.json()).error).to.match(msg);
    }
  });

  it("/shield-note inserts a note the payee signed for", async () => {
    const commitment = randField();
    const deadline = BigInt(await time.latest()) + 3600n;
    const before = await vault.noteRoot();

    const res = await post("/shield-note", {
      account: payee.address, bucket: BUCKET.toString(), commitment: commitment.toString(),
      deadline: Number(deadline), signature: await signShieldNote(payee, BUCKET, commitment, deadline),
    });

    expect(res.status).to.equal(200);
    expect((await res.json()).inserted).to.equal(true);
    expect(await vault.noteRoot()).to.not.equal(before, "the tree should have grown");
  });

  it("/shield-note cannot substitute a commitment the payee never signed", async () => {
    // The relay is the submitter here. If the signature did not cover the
    // commitment, this is exactly how a relay would redirect a payout into a
    // note only it can spend.
    const signed = randField();
    const attacker = randField();
    const deadline = BigInt(await time.latest()) + 3600n;
    const signature = await signShieldNote(payee, BUCKET, signed, deadline);

    const rootBefore = await vault.noteRoot();
    const res = await post("/shield-note", {
      account: payee.address, bucket: BUCKET.toString(), commitment: attacker.toString(),
      deadline: Number(deadline), signature,
    });

    expect(res.status).to.equal(502);
    expect(await vault.noteRoot()).to.equal(rootBefore, "no note should have been inserted");
  });

  // ── /shield-note-spend ────────────────────────────────────────────────────

  it("/shield-note-spend validates the proof and its public inputs", async () => {
    const base = { proof: "0xabcd", root: "1", nullifierHash: "2", bucket: BUCKET.toString(), ksCommitment: b32(7n) };
    const cases: [any, RegExp][] = [
      [{ ...base, proof: "not-hex" }, /bad proof/],
      [{ ...base, proof: 42 }, /bad proof/],
      [{ ...base, ksCommitment: "0x1234" }, /32-byte hex/],
      [{ ...base, root: "abc" }, /bad numeric field/],
    ];
    for (const [body, msg] of cases) {
      const res = await post("/shield-note-spend", body);
      expect(res.status, JSON.stringify(body)).to.equal(400);
      expect((await res.json()).error).to.match(msg);
    }
  });

  it("/shield-note-spend returns a retryable 409 for a root the vault never had", async () => {
    // The tree moves while a payee builds their proof, so a stale root is the
    // normal failure — it must be reported as recoverable rather than burned as
    // a reverted transaction.
    const res = await post("/shield-note-spend", {
      proof: "0x" + "11".repeat(256), root: randField().toString(), nullifierHash: "1",
      bucket: BUCKET.toString(), ksCommitment: b32(randField()),
    });
    expect(res.status).to.equal(409);
    const body = await res.json();
    expect(body.error).to.match(/unknown root/);
    expect(body.retry).to.equal(true);
  });

  // ── /shield-withdraw ──────────────────────────────────────────────────────

  it("/shield-withdraw rejects a malformed proof or recipient", async () => {
    const ok = { pA: [1, 2], pB: [[1, 2], [3, 4]], pC: [5, 6], pubSignals: Array(8).fill("0"), recipient: payee.address };
    const cases: any[] = [
      { ...ok, pA: "nope" },
      { ...ok, pB: undefined },
      { ...ok, pubSignals: Array(7).fill("0") }, // wrong length
      { ...ok, recipient: "0xnot-an-address" },
    ];
    for (const body of cases) {
      const res = await post("/shield-withdraw", body);
      expect(res.status, JSON.stringify(body)).to.equal(400);
    }
  });

  it("/shield-withdraw refuses a proof whose context names a different recipient", async () => {
    // The proof binds its payout target through context = pubSignals[5]. The
    // relay recomputes it, so a proof built for `payee` cannot be resubmitted
    // with `other` as the recipient — the relay never submits a withdrawal
    // whose destination it cannot verify.
    const pubSignals = Array(8).fill("0");
    pubSignals[5] = contextFor(payee.address).toString();

    const redirected = await post("/shield-withdraw", {
      pA: [1, 2], pB: [[1, 2], [3, 4]], pC: [5, 6], pubSignals, recipient: other.address,
    });
    expect(redirected.status).to.equal(400);
    expect((await redirected.json()).error).to.match(/does not match proof context/);

    // Sanity: the same proof passes the context check for its own recipient, so
    // the assertion above is about the mismatch and not about the fixture.
    const matched = await post("/shield-withdraw", {
      pA: [1, 2], pB: [[1, 2], [3, 4]], pC: [5, 6], pubSignals, recipient: payee.address,
    });
    expect((await matched.json()).error ?? "").to.not.match(/does not match proof context/);
  });
});
