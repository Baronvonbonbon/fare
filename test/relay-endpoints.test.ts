import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, setBalance } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Relay endpoints that need a chain (TEST-PLAN C1, second chunk). The no-chain
// half — routing, CORS, the in-memory stores, the rate limiter, input
// validation — lives in venue-node/relay.test.mjs and runs with no deps.
//
// This half is here rather than in the venue-node suite for one reason: these
// assertions are about what the CONTRACTS let the relay do, and the contracts
// already exist in this tier. Wiring hardhat into a suite whose only dependency
// is ethers, purely to re-deploy them, would have been the more expensive half
// of the same test.
//
// The relay is the real relay.mjs, unmodified, talking to hardhat's in-process
// chain through the small JSON-RPC bridge below. What is under test is the
// boundary the relay does NOT control: it holds a funded key and submits other
// people's signed payloads, so the question is whether a malicious or buggy
// relay can move value the signer did not authorize. Every answer here is
// enforced by the vault or the forwarder, not by the relay's own checks.

// The relay is ESM and hardhat's runner is CJS, so pull it through a REAL
// dynamic import — a plain `import` transpiles to require() and dies at the
// boundary. Same trick as privacy-e2e.test.ts.
const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;

const PAS = (n: string | number) => ethers.parseEther(String(n));

/// Expose hardhat's in-process provider over HTTP so the relay — which builds
/// its own JsonRpcProvider from a URL and cannot be handed one — talks to the
/// same chain the assertions read. Supports batching because ethers batches.
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

describe("relay endpoints (against a real chain)", () => {
  let dir: string;
  let bridge: { url: string; close: () => void };
  let relayUrl: string;
  let relayServer: any;
  let relayWallet: ethers.HDNodeWallet;

  let vault: any, orders: any, forwarder: any, ratings: any, settlement: any, drivers: any, venues: any;
  let deployer: HardhatEthersSigner, customer: HardhatEthersSigner, driver: HardhatEthersSigner,
      stranger: HardhatEthersSigner, treasury: HardhatEthersSigner, venueOp: HardhatEthersSigner,
      venueSigner: HardhatEthersSigner;
  let chainId: bigint;

  const rawPost = (path: string, body: any, url = relayUrl) =>
    fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  /// Spaced past the ~250 ms read cache in the relay's own provider — ethers
  /// caches `eth_getBalance` / `eth_call` per tag, so a request that depends on
  /// the relay *observing* state a previous request just changed needs the gap.
  ///
  /// This is NOT the nonce defect (fixed — see the concurrency tests, which use
  /// rawPost precisely to prove submissions no longer need spacing). It is a
  /// read-freshness property of ethers, and it is worth knowing that it is real:
  /// two /fund calls for the same address inside that window both see a zero
  /// balance and both pay out.
  const post = async (path: string, body: any, url = relayUrl) => {
    await new Promise((r) => setTimeout(r, 300));
    return rawPost(path, body, url);
  };

  /// EIP-712 Withdraw, as FareVault.withdrawFor verifies it. `nonceOverride`
  /// and a mismatched `signFor` recipient are what the attack cases need.
  async function signWithdraw(
    account: HardhatEthersSigner,
    recipient: string,
    deadline: number,
    opts: { signer?: HardhatEthersSigner; nonce?: bigint } = {}
  ) {
    const nonce = opts.nonce ?? (await vault.withdrawNonce(account.address));
    return (opts.signer ?? account).signTypedData(
      { name: "FareVault", version: "1", chainId, verifyingContract: vault.target as string },
      {
        Withdraw: [
          { name: "account", type: "address" },
          { name: "recipient", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { account: account.address, recipient, nonce, deadline }
    );
  }

  /// EIP-2771 ForwardRequest for FareForwarder, JSON-safe (the relay receives it
  /// over HTTP, so every bigint has to survive JSON.stringify).
  async function signForward(signer: HardhatEthersSigner, target: string, data: string) {
    const nonce = await forwarder.nonces(signer.address);
    const deadline = (await time.latest()) + 3600;
    const req = { from: signer.address, to: target, value: 0n, gas: 500_000n, nonce, deadline: BigInt(deadline), data };
    const signature = await signer.signTypedData(
      { name: "FareForwarder", version: "1", chainId, verifyingContract: forwarder.target as string },
      {
        ForwardRequest: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "gas", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint48" },
          { name: "data", type: "bytes" },
        ],
      },
      req
    );
    return { from: req.from, to: req.to, value: "0", gas: "500000", deadline: String(deadline), data, signature };
  }

  before(async function () {
    this.timeout(120_000);
    [deployer, treasury, customer, driver, stranger, venueOp, venueSigner] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    // ── the system under the relay ──────────────────────────────────────────
    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    vault = await (await ethers.getContractFactory("FareVault")).deploy();
    drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    ratings = await (await ethers.getContractFactory("FareRatings")).deploy(forwarder.target);
    await ratings.configure(orders.target);

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await vault.setAuthorized(deployer.address, true); // credit() directly, to fund withdraw cases
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);
    await drivers.connect(driver).register("ipfs://driver", { value: PAS(1) });
    await venues.connect(venueOp).registerVenue(37_774_900, -122_419_400, venueSigner.address, venueOp.address, "ipfs://venue");

    // an Open order, so a forwarded placeBid has something to bid on. The drop
    // commit only has to be non-zero here — no dropoff is settled in this file.
    const dropCommit = ethers.keccak256(ethers.toUtf8Bytes("relay-endpoints-drop"));
    await orders.connect(customer).createOrder(1n, dropCommit, 0, 0, PAS(1), 0, 0, { value: 0 });

    // ── the relay, pointed at all of it ─────────────────────────────────────
    bridge = await startRpcBridge();
    dir = mkdtempSync(join(tmpdir(), "fare-relay-"));
    const book = join(dir, "addresses.json");
    writeFileSync(book, JSON.stringify({
      settlement: settlement.target, orders: orders.target, vault: vault.target,
      forwarder: forwarder.target, ratings: ratings.target, drivers: drivers.target, venues: venues.target,
    }));

    relayWallet = ethers.Wallet.createRandom();
    await setBalance(relayWallet.address, PAS(10_000));

    // relay.mjs prefers PINE_RPC over RELAY_RPC_URL, and hardhat.config.ts runs
    // dotenv.config() — so a PINE_RPC in .env silently wins and the relay under
    // test talks to a real node instead of this bridge. Clear it explicitly.
    delete process.env.PINE_RPC;
    process.env.RELAY_PRIVATE_KEY = relayWallet.privateKey;
    process.env.RELAY_RPC_URL = bridge.url;
    process.env.ADDRESS_BOOK = book; // absolute → resolves as file:// inside relay.mjs
    process.env.RATE_MAX = "100000";
    // The guard is exercised on its own instance at the end; with testnet-sized
    // fares it would otherwise decline everything and hide the authz behaviour.
    process.env.RELAY_PROFIT_GUARD = "off";

    const relayMod = await esmImport(pathToFileURL(join(__dirname, "..", "venue-node", "relay.mjs")).href + "?chain");
    relayServer = relayMod.server;
    relayUrl = await new Promise((r) =>
      relayServer.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${relayServer.address().port}`)));
  });

  after(() => {
    relayServer?.close();
    bridge?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ── /health + /fund ───────────────────────────────────────────────────────

  it("/health reports the relay account and its live balance", async () => {
    const res = await fetch(`${relayUrl}/health`);
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.ok).to.equal(true);
    expect(body.relay).to.equal(relayWallet.address);
    expect(body.settlement.toLowerCase()).to.equal((settlement.target as string).toLowerCase());
    // read straight through, not cached at boot
    expect(PAS(body.balance)).to.equal(await ethers.provider.getBalance(relayWallet.address));
  });

  it("/fund tops up an empty burner, and declines one that already has gas", async () => {
    const burner = ethers.Wallet.createRandom().address;
    expect(await ethers.provider.getBalance(burner)).to.equal(0n);

    const res = await post("/fund", { address: burner });
    expect(res.status).to.equal(200);
    expect((await res.json()).funded).to.equal(true);
    expect(await ethers.provider.getBalance(burner)).to.be.greaterThan(0n);

    // Second call: already above FUND_MIN → no second transfer. This is the
    // whole defense against /fund being used as an unbounded faucet.
    const again = await post("/fund", { address: burner });
    const body = await again.json();
    expect(body.funded).to.equal(false);
    expect(body.reason).to.equal("sufficient");
  });

  // ── /withdraw: the signature is the only thing standing between a relay and
  //    someone else's vault balance ─────────────────────────────────────────

  it("/withdraw pays out on the account's own signature", async () => {
    await vault.connect(deployer).credit(driver.address, { value: PAS(4) });
    const recipient = ethers.Wallet.createRandom().address;
    const deadline = (await time.latest()) + 3600;

    const res = await post("/withdraw", {
      account: driver.address, recipient, deadline,
      signature: await signWithdraw(driver, recipient, deadline),
    });

    expect(res.status).to.equal(200);
    expect((await res.json()).withdrawn).to.equal(true);
    expect(await ethers.provider.getBalance(recipient)).to.equal(PAS(4));
    expect(await vault.balanceOf(driver.address)).to.equal(0n);
  });

  it("/withdraw refuses a signature from anyone but the account", async () => {
    await vault.connect(deployer).credit(driver.address, { value: PAS(2) });
    const recipient = stranger.address;
    const deadline = (await time.latest()) + 3600;

    // stranger signs a withdrawal of the DRIVER's balance to themselves
    const res = await post("/withdraw", {
      account: driver.address, recipient, deadline,
      signature: await signWithdraw(driver, recipient, deadline, { signer: stranger }),
    });

    expect(res.status).to.be.gte(400);
    expect(await vault.balanceOf(driver.address)).to.equal(PAS(2), "balance must be untouched");
  });

  it("/withdraw cannot be re-pointed at a recipient the account never signed for", async () => {
    // The signed recipient and the submitted recipient differ — this is the
    // exact move a malicious relay would make, and the digest must not verify.
    const signedFor = ethers.Wallet.createRandom().address;
    const attackerRecipient = stranger.address;
    const deadline = (await time.latest()) + 3600;

    const res = await post("/withdraw", {
      account: driver.address, recipient: attackerRecipient, deadline,
      signature: await signWithdraw(driver, signedFor, deadline),
    });

    expect(res.status).to.be.gte(400);
    expect(await vault.balanceOf(driver.address)).to.equal(PAS(2), "balance must be untouched");
  });

  it("/withdraw rejects a replayed signature even when the balance is refilled", async () => {
    const recipient = ethers.Wallet.createRandom().address;
    const deadline = (await time.latest()) + 3600;
    const signature = await signWithdraw(driver, recipient, deadline);

    const first = await post("/withdraw", { account: driver.address, recipient, deadline, signature });
    expect(first.status).to.equal(200);
    expect(await ethers.provider.getBalance(recipient)).to.equal(PAS(2));

    // Refill, so the replay fails on the NONCE rather than on a zero balance —
    // otherwise this test would pass without any replay guard at all.
    await vault.connect(deployer).credit(driver.address, { value: PAS(3) });

    const replay = await post("/withdraw", { account: driver.address, recipient, deadline, signature });
    expect(replay.status).to.be.gte(400);
    expect(await ethers.provider.getBalance(recipient)).to.equal(PAS(2), "replay must not pay twice");
    expect(await vault.balanceOf(driver.address)).to.equal(PAS(3));
  });

  it("/withdraw rejects an expired deadline", async () => {
    const recipient = ethers.Wallet.createRandom().address;
    const deadline = (await time.latest()) - 60; // already past
    const res = await post("/withdraw", {
      account: driver.address, recipient, deadline,
      signature: await signWithdraw(driver, recipient, deadline),
    });
    expect(res.status).to.be.gte(400);
    expect(await vault.balanceOf(driver.address)).to.equal(PAS(3));
  });

  // ── /forward: the relay picks the target, so the allowlist is its own ─────

  it("/forward relays a user-signed action under the user's identity", async () => {
    const amount = PAS("0.3");
    const data = orders.interface.encodeFunctionData("placeBid", [1n, amount]);
    const request = await signForward(driver, orders.target as string, data);

    const res = await post("/forward", { request });
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.forwarded).to.equal(true);
    expect(body.fn).to.equal("placeBid");
    // identity is the driver, not the relay — the point of EIP-2771
    expect(await orders.bidOf(1n, driver.address)).to.equal(amount);
  });

  it("/forward refuses a target outside the allowlist", async () => {
    // A relay that forwards arbitrary targets is a signing oracle for any
    // contract that trusts this forwarder. Only orders + ratings are allowed.
    const data = orders.interface.encodeFunctionData("placeBid", [1n, PAS("0.1")]);
    const request = await signForward(driver, vault.target as string, data);

    const res = await post("/forward", { request });
    expect(res.status).to.equal(400);
    expect((await res.json()).error).to.match(/not allowlisted/);
  });

  it("/forward refuses to carry value", async () => {
    const data = orders.interface.encodeFunctionData("placeBid", [1n, PAS("0.1")]);
    const request = { ...(await signForward(driver, orders.target as string, data)), value: "1" };

    const res = await post("/forward", { request });
    expect(res.status).to.equal(400);
    expect((await res.json()).error).to.match(/value must be 0/);
  });

  it("/forward cannot forge the sender — a mismatched signature is rejected", async () => {
    const data = orders.interface.encodeFunctionData("placeBid", [1n, PAS("0.9")]);
    const signed = await signForward(driver, orders.target as string, data);
    // claim to be the customer while carrying the driver's signature
    const request = { ...signed, from: customer.address };

    const res = await post("/forward", { request });
    expect(res.status).to.be.gte(400);
    expect(await orders.bidOf(1n, customer.address)).to.equal(0n);
  });

  // ── concurrency ──────────────────────────────────────────────────────────

  it("submits concurrent requests on distinct nonces", async () => {
    // This was a real defect: nonces came from getTransactionCount(relay,
    // "latest"), which excludes a submitted-but-unmined transaction, and ethers
    // caches that read for ~250 ms on top — so two requests inside the same
    // block window drew the SAME nonce and the node rejected the second.
    // `serialize()` ordered the sends but did not give them distinct nonces.
    //
    // On a chain with multi-second blocks that is not a narrow race: any two
    // users arriving together could trigger it, and at least one got a 500.
    // The relay now allocates nonces locally (seeded "pending", resynced on
    // failure), which is safe precisely because every send is serialized.
    const burners = [0, 1, 2, 3, 4].map(() => ethers.Wallet.createRandom().address);

    // rawPost: no spacing at all. That is the point — these five submissions
    // land inside the window that used to guarantee a nonce collision.
    const responses = await Promise.all(burners.map((address) => rawPost("/fund", { address })));
    for (const [i, r] of responses.entries()) {
      expect(r.status, `burner ${i}: ${await r.clone().text()}`).to.equal(200);
      expect((await r.json()).funded).to.equal(true);
    }

    // Every burner actually received its transfer — no silent drops.
    for (const [i, b] of burners.entries()) {
      expect(await ethers.provider.getBalance(b), `burner ${i} went unfunded`).to.be.greaterThan(0n);
    }
  });

  it("recovers its nonce after a failed submission", async () => {
    // A send that never landed must not leave a gap — the node would queue
    // every later transaction behind a nonce that never arrives, wedging the
    // relay until restart. Drive a guaranteed failure, then a normal request.
    const bad = await post("/withdraw", {
      account: stranger.address, // no vault balance → reverts
      recipient: stranger.address,
      deadline: (await time.latest()) + 3600,
      signature: await signWithdraw(stranger, stranger.address, (await time.latest()) + 3600),
    });
    expect(bad.status).to.be.gte(400);

    const burner = ethers.Wallet.createRandom().address;
    const res = await post("/fund", { address: burner });
    expect(res.status).to.equal(200, "the relay did not recover from a failed send");
    expect(await ethers.provider.getBalance(burner)).to.be.greaterThan(0n);
  });

  // ── C2: the profitability guard, on its own instance ─────────────────────

  it("declines a withdrawal whose fee cannot cover its gas (profit guard on)", async () => {
    // withdrawFeeBps is 0 on this deployment, so the relay earns nothing for a
    // withdrawal and must decline rather than subsidise it.
    expect(await vault.withdrawFeeBps()).to.equal(0);

    process.env.RELAY_PROFIT_GUARD = "on";
    const guarded = await esmImport(pathToFileURL(join(__dirname, "..", "venue-node", "relay.mjs")).href + "?guard");
    const url: string = await new Promise((r) =>
      guarded.server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${guarded.server.address().port}`)));

    try {
      const recipient = ethers.Wallet.createRandom().address;
      const deadline = (await time.latest()) + 3600;
      const res = await post("/withdraw", {
        account: driver.address, recipient, deadline,
        signature: await signWithdraw(driver, recipient, deadline),
      }, url);

      expect(res.status).to.equal(402);
      const body = await res.json();
      expect(body.declined).to.equal(true);
      expect(body.error).to.match(/withdraw fee below gas cost/);
      // declined means NOT submitted — the balance is still there
      expect(await vault.balanceOf(driver.address)).to.equal(PAS(3));
    } finally {
      guarded.server.close();
      process.env.RELAY_PROFIT_GUARD = "off";
    }
  });
});
