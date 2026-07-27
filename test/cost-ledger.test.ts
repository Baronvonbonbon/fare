import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time, setBalance } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Per-payer cost ledger for a whole delivery, on a local chain (TEST-PLAN A3).
//
// scripts/privacy/measure-costs.mjs measures this live on Paseo through three
// real relay processes. That run is the source of truth for the numbers, and it
// cannot gate a pull request: it needs a funded deployer and three running
// relays. This is the half that can — the same lifecycle, the same ledger
// module, the same report shape, against hardhat.
//
// The numbers here are not the point (A1's gas snapshot owns those). WHO PAYS
// is. A change that quietly moves a cost from the relay onto the customer does
// not alter the total, and an aggregate would hide it entirely — so every step
// is asserted against the party that should have footed it.

const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
const PAS = (n: string | number) => ethers.parseEther(String(n));
const abi = ethers.AbiCoder.defaultAbiCoder();

const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const NEAR = { lat: 37_775_100, lon: -122_419_400 };
const DROP_SALT = 0xfeedn;

const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "lat", type: "int32" },
    { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
  ],
};
const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

/// Hardhat's in-process chain over HTTP, so the relay — which builds its own
/// provider from a URL — talks to the same chain the assertions read.
function startRpcBridge(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const one = async (r: any) => {
      try {
        return { jsonrpc: "2.0", id: r.id, result: await network.provider.request({ method: r.method, params: r.params ?? [] }) };
      } catch (e: any) {
        // `data` is forwarded ONLY when it is revert data. Hardhat sometimes
        // attaches an object there, and ethers cannot coalesce a JSON-RPC error
        // whose data is not a hex string — it surfaces as an opaque
        // "could not coalesce error" three frames from anything relevant.
        const err: any = { code: typeof e?.code === "number" ? e.code : -32000, message: String(e?.message ?? e) };
        if (typeof e?.data === "string" && e.data.startsWith("0x")) err.data = e.data;
        if (process.env.LEDGER_DEBUG) console.log("  BRIDGE ERR", r.method, "id=", r.id, "->", err.message.slice(0, 140));
        return { jsonrpc: "2.0", id: r.id, error: err };
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
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => server.close() })));
}

describe("cost ledger: who pays for a delivery", function () {
  this.timeout(180_000);

  let createLedger: any;
  let dir: string, bridge: any, relayServer: any, relayUrl: string;
  let vault: any, orders: any, settlement: any, drivers: any, venues: any;
  let deployer: HardhatEthersSigner, treasury: HardhatEthersSigner, customer: HardhatEthersSigner,
      driver: HardhatEthersSigner, venueOp: HardhatEthersSigner, venueSigner: HardhatEthersSigner;
  let relayWallet: ethers.HDNodeWallet;
  let domain: any;
  let ledger: any;

  const GAS_PRICE = 1_000n * 10n ** 9n; // Paseo's, so the PAS figures are comparable to the live run

  const post = async (path: string, body: any) => {
    await new Promise((r) => setTimeout(r, 300)); // past the provider's read cache
    return fetch(`${relayUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  };

  /// POST to the relay and return the tx hash, failing loudly with the body if
  /// the relay declined — a null hash otherwise surfaces as an opaque decoding
  /// error several frames away.
  async function relayTx(path: string, body: any): Promise<string> {
    const res = await post(path, body);
    const j: any = await res.json().catch(() => ({}));
    expect(j.txHash, `${path} → ${res.status} ${JSON.stringify(j)}`).to.be.a("string");
    return j.txHash;
  }

  /// Record a mined transaction against the party that paid its gas.
  async function track(step: string, payer: string, hash: string, opts: { via?: string; revenue?: bigint } = {}) {
    const rc = await ethers.provider.getTransactionReceipt(hash);
    expect(rc, `${step}: no receipt`).to.not.equal(null);
    return ledger.record({
      step, payer, via: opts.via ?? null,
      gasUsed: rc!.gasUsed, gasPrice: GAS_PRICE, revenue: opts.revenue ?? 0n,
    });
  }

  before(async () => {
    ({ createLedger } = await esmImport(
      pathToFileURL(join(__dirname, "..", "scripts", "privacy", "ledger.mjs")).href
    ));
    ledger = createLedger();

    [deployer, treasury, customer, driver, venueOp, venueSigner] = await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    vault = await (await ethers.getContractFactory("FareVault")).deploy();
    drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    const verifier = await (await ethers.getContractFactory("MockLocationVerifier")).deploy();

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(verifier.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);
    await drivers.connect(driver).register("ipfs://d", { value: PAS(1) });
    await venues.connect(venueOp).registerVenue(VENUE.lat, VENUE.lon, venueSigner.address, venueOp.address, "ipfs://v");
    await vault.setWithdrawFeeBps(100); // 1%, as deployed — the relay's only revenue

    domain = {
      name: "FareSettlement", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: settlement.target as string,
    };

    bridge = await startRpcBridge();
    dir = mkdtempSync(join(tmpdir(), "fare-ledger-"));
    const book = join(dir, "addresses.json");
    writeFileSync(book, JSON.stringify({
      settlement: settlement.target, orders: orders.target, vault: vault.target,
      forwarder: forwarder.target, drivers: drivers.target, venues: venues.target,
    }));

    relayWallet = ethers.Wallet.createRandom();
    await setBalance(relayWallet.address, PAS(10_000));

    delete process.env.PINE_RPC;
    process.env.RELAY_PRIVATE_KEY = relayWallet.privateKey;
    process.env.RELAY_RPC_URL = bridge.url;
    process.env.ADDRESS_BOOK = book;
    process.env.RATE_MAX = "100000";
    process.env.RELAY_PROFIT_GUARD = "off"; // A2 owns the economics; this owns the attribution
    // Paseo's 500 M weight-scale settlement limit exceeds hardhat's per-tx gas
    // cap of 2^24, so the relay could not settle here at all without this.
    // See TEST-FINDINGS #18.
    process.env.RELAY_GAS_SETTLE = "15000000";

    const mod = await esmImport(pathToFileURL(join(__dirname, "..", "venue-node", "relay.mjs")).href + "?ledger");
    relayServer = mod.server;
    relayUrl = await new Promise((r) =>
      relayServer.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${relayServer.address().port}`)));

    // ── the delivery ────────────────────────────────────────────────────────
    // A genuine fresh burner, not a pre-funded hardhat signer: /fund declines an
    // address that already holds gas, which is exactly what it should do — and
    // it means only a real burner exercises the sponsorship path.
    const burner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ethers.provider);
    expect(await ethers.provider.getBalance(burner.address)).to.equal(0n);
    const orderId = 1n;
    const dropCommit = ethers.keccak256(abi.encode(["int32", "int32", "uint256"], [37_784_913, -122_431_777, DROP_SALT]));

    // 1. the relay sponsors the customer burner's gas
    await track("/fund (sponsor gas)", "relay", await relayTx("/fund", { address: burner.address }), { via: "relay" });

    // 2. the customer escrows — a VALUE action, never relayed
    // Sized to fit what the relay sponsors (5 PAS), with room for gas.
    const co = await orders.connect(burner).createOrder(1n, dropCommit, PAS("0.5"), 0, PAS(2), 0, 0, { value: PAS("0.5") });
    await track("createOrder", "customer", co.hash);

    const bid = await orders.connect(driver).placeBid(orderId, PAS(1));
    await track("placeBid", "driver", bid.hash);

    const acc = await orders.connect(burner).acceptBid(orderId, driver.address, { value: PAS(1) });
    await track("acceptBid", "customer", acc.hash);

    // 3. settlement, relayed — gasless for both parties
    let now = await time.latest();
    // orderId goes over the wire as a string (JSON cannot carry a BigInt) but
    // must be signed as one — hence the two shapes.
    const dAtt = { orderId: orderId.toString(), phase: 1, actor: driver.address, lat: NEAR.lat, lon: NEAR.lon, timestamp: now };
    const vAtt = { orderId: orderId.toString(), phase: 1, actor: venueSigner.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    const puHash = await relayTx("/submit", {
      method: "confirmPickup",
      args: [dAtt, await driver.signTypedData(domain, LOCATION_TYPES, { ...dAtt, orderId }),
             vAtt, await venueSigner.signTypedData(domain, LOCATION_TYPES, { ...vAtt, orderId })],
    });
    await track("/submit confirmPickup", "relay", puHash, { via: "relay" });

    now = await time.latest();
    const posCommit = ethers.keccak256(abi.encode(["string", "uint256"], ["pos", orderId]));
    const dropAtt = { orderId: orderId.toString(), phase: 2, actor: driver.address, posCommit, timestamp: now };
    const dzHash = await relayTx("/submit", {
      method: "confirmDropoffZK",
      args: [dropAtt, await driver.signTypedData(domain, DRIVER_COMMIT_TYPES, { ...dropAtt, orderId }),
             "0x" + "00".repeat(256),
             [orderId.toString(), BigInt(dropCommit).toString(), BigInt(posCommit).toString(),
              (await settlement.dropoffRadiusMeters()).toString(), "1"]],
    });
    await track("/submit confirmDropoffZK", "relay", dzHash, { via: "relay" });

    // 4. the driver cashes out gaslessly — the relay's only earning endpoint
    const relayBefore = await vault.balanceOf(relayWallet.address);
    const deadline = (await time.latest()) + 3600;
    const sig = await driver.signTypedData(
      { name: "FareVault", version: "1", chainId: domain.chainId, verifyingContract: vault.target },
      { Withdraw: [
        { name: "account", type: "address" }, { name: "recipient", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { account: driver.address, recipient: driver.address, nonce: await vault.withdrawNonce(driver.address), deadline }
    );
    const wdHash = await relayTx("/withdraw", { account: driver.address, recipient: driver.address, deadline, signature: sig });
    // Read the fee only AFTER the transaction mines — the POST returns on
    // submission, and reading earlier reports zero for the one endpoint that earns.
    await ethers.provider.getTransactionReceipt(wdHash);
    const fee = (await vault.balanceOf(relayWallet.address)) - relayBefore;
    await track("/withdraw (gasless, earns 1%)", "relay", wdHash, { via: "relay", revenue: fee });

    // 5. the venue takes the unsubsidised path
    const vw = await vault.connect(venueOp).withdraw();
    await track("vault.withdraw (venue, own gas)", "venue", vw.hash);
  });

  after(() => {
    relayServer?.close();
    bridge?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ── attribution ───────────────────────────────────────────────────────────

  it("the relay foots every gasless step, and no value action", async () => {
    // The F8 bargain: the relay pays for the actions that move no user value,
    // and never fronts escrow. If a value action ever shows up on the relay's
    // tab, the relay is funding orders.
    const relaySteps = ledger.stepsFor("relay");
    expect(relaySteps).to.include("/submit confirmPickup");
    expect(relaySteps).to.include("/submit confirmDropoffZK");
    expect(relaySteps).to.include("/fund (sponsor gas)");
    expect(relaySteps).to.include("/withdraw (gasless, earns 1%)");

    for (const valueAction of ["createOrder", "acceptBid"]) {
      expect(relaySteps, `the relay paid for ${valueAction} — it must never front escrow`)
        .to.not.include(valueAction);
    }
  });

  it("the customer pays only for the two actions that move their own money", async () => {
    expect(ledger.stepsFor("customer")).to.deep.equal(["createOrder", "acceptBid"]);
  });

  it("the driver pays for nothing but their own bid", async () => {
    // Settlement and cash-out are both relayed, so a driver needs gas for the
    // bid alone — and with a forwarder even that goes away.
    expect(ledger.stepsFor("driver")).to.deep.equal(["placeBid"]);
  });

  it("the relay earns on exactly one step, and loses money overall", async () => {
    const earning = ledger.rows().filter((r: any) => r.revenue > 0n);
    expect(earning).to.have.length(1);
    expect(earning[0].step).to.equal("/withdraw (gasless, earns 1%)");

    // The economics A2 quantified, visible as a balance: at these fares the
    // relay is a subsidy. If this ever flips, the parameters changed and
    // breakeven.test.mjs should have said so first.
    const relay = ledger.byPayer()["relay"];
    expect(relay.revenue).to.be.greaterThan(0n);
    expect(relay.net, "the relay turned a profit — check breakeven.test.mjs").to.be.lessThan(0n);
  });

  it("emits the same report shape as the live run", async () => {
    const report = ledger.report({ chain: "hardhat", gasPriceGwei: "1000" });
    expect(report).to.have.keys(["chain", "gasPriceGwei", "totals", "byPayer", "ledger"]);
    expect(report.totals).to.have.keys(["txs", "costPAS", "revenuePAS", "netPAS"]);
    expect(report.ledger).to.have.length(ledger.length);
    for (const row of report.ledger) {
      expect(row).to.have.keys(["step", "payer", "via", "gasUsed", "costPAS", "revenuePAS", "netPAS"]);
    }
    // Every party accounted for, none invented.
    expect(Object.keys(report.byPayer).sort()).to.deep.equal(["customer", "driver", "relay", "venue"]);

    console.log(`\n    per-payer cost of one delivery (hardhat gas @ 1000 gwei):`);
    for (const [who, v] of Object.entries(report.byPayer) as any) {
      console.log(`      ${who.padEnd(9)} ${String(v.txs).padStart(2)} tx  cost ${v.costPAS.padStart(10)}  revenue ${v.revenuePAS.padStart(8)}  net ${v.netPAS}`);
    }
  });

  // ── the accounting itself ─────────────────────────────────────────────────

  it("the ledger's arithmetic holds", async () => {
    const rows = ledger.rows();
    const byPayer = ledger.byPayer();

    // Per-payer totals reconstruct from the rows, and the whole reconstructs
    // from the payers — an off-by-one in the grouping would pass a spot check.
    let cost = 0n, revenue = 0n, txs = 0;
    for (const r of rows) { cost += r.gasUsed * r.gasPrice; revenue += r.revenue; txs++; }
    const summed = Object.values(byPayer) as any[];
    expect(summed.reduce((a, v) => a + v.cost, 0n)).to.equal(cost);
    expect(summed.reduce((a, v) => a + v.revenue, 0n)).to.equal(revenue);
    expect(summed.reduce((a, v) => a + v.txs, 0)).to.equal(txs);
    for (const v of summed) expect(v.net).to.equal(v.revenue - v.cost);
  });

  it("the ledger refuses an unattributed cost", async () => {
    // A row without a payer is the failure this whole file exists to prevent:
    // a cost that landed on somebody, recorded against nobody.
    const l = createLedger();
    expect(() => l.record({ step: "x", gasUsed: 1n, gasPrice: 1n })).to.throw(/payer/);
    expect(() => l.record({ payer: "relay", gasUsed: 1n, gasPrice: 1n })).to.throw(/step/);
    expect(() => l.record({ step: "x", payer: "relay", gasUsed: -1n, gasPrice: 1n })).to.throw(/non-negative/);
    expect(l.length).to.equal(0);
  });
});
