import { expect } from "chai";
import { ethers, network } from "hardhat";
import { setBalance } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Relay key custody (TEST-PLAN C2).
//
// The relay holds a hot key that pays for other people's transactions. C1 asked
// whether it can move value nobody authorized — the contracts answer that. This
// file asks the other question, the one no contract can answer: **can the key be
// drained through the endpoints that are working exactly as designed?**
//
// Everything here runs with `RELAY_PROFIT_GUARD=on`, which is the deployed
// default and the opposite of the C1 files. The guard is the whole subject, so
// it cannot be the thing that is switched off.
//
// The relay's own answer is a rolling subsidy budget: `RELAY_GAS_BUDGET_PAS` of
// no-reward spend per `RELAY_BUDGET_WINDOW_MS`, checked by `budgetRoom()` before
// each unpaid action and added to by `recordBudget()` after. This file drives
// that budget to its limit and past it.
//
// Two of these tests document defects rather than defenses — see
// TEST-FINDINGS #19 and #20. They are written to the behaviour that exists, and
// each says what it would look like fixed.

const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;
const PAS = (n: string | number) => ethers.parseEther(String(n));

function startRpcBridge(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const one = async (r: any) => {
      try {
        return { jsonrpc: "2.0", id: r.id, result: await network.provider.request({ method: r.method, params: r.params ?? [] }) };
      } catch (e: any) {
        const err: any = { code: typeof e?.code === "number" ? e.code : -32000, message: String(e?.message ?? e) };
        if (typeof e?.data === "string" && e.data.startsWith("0x")) err.data = e.data;
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

describe("relay key custody: what the subsidy budget actually bounds", function () {
  this.timeout(180_000);

  let dir: string, bridge: { url: string; close: () => void }, book: string;
  let vault: any, orders: any, drivers: any;
  let deployer: HardhatEthersSigner, treasury: HardhatEthersSigner, customer: HardhatEthersSigner,
      driver: HardhatEthersSigner, venueOp: HardhatEthersSigner, venueSigner: HardhatEthersSigner;

  const started: any[] = [];

  /// A relay instance with its own config, its own funded key, and its own
  /// budget window. Config is read once at module scope, so a fresh query string
  /// is the only way to get a differently-configured relay — the same mechanism
  /// the C1 suites use, and the reason each scenario here gets its own instance.
  async function startRelay(tag: string, env: Record<string, string>, fundPAS = 1_000) {
    const wallet = ethers.Wallet.createRandom();
    await setBalance(wallet.address, PAS(fundPAS));

    delete process.env.PINE_RPC; // .env would otherwise point the relay at a real node
    const base: Record<string, string> = {
      RELAY_PRIVATE_KEY: wallet.privateKey,
      RELAY_RPC_URL: bridge.url,
      ADDRESS_BOOK: book,
      RATE_MAX: "100000",        // the rate limiter is a separate backstop (C1)
      RELAY_PROFIT_GUARD: "on",  // the subject
    };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries({ ...base, ...env })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const mod = await esmImport(pathToFileURL(join(__dirname, "..", "venue-node", "relay.mjs")).href + `?custody-${tag}`);
      const url: string = await new Promise((r) =>
        mod.server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${mod.server.address().port}`)));
      started.push(mod.server);
      return { url, wallet, server: mod.server };
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const rawPost = (url: string, path: string, body: any) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  /// Spaced past ethers' ~250 ms read cache, so the relay observes state a
  /// previous request changed. Not the nonce defect (fixed); a read-freshness
  /// property — see TEST-FINDINGS #2.
  const post = async (url: string, path: string, body: any) => {
    await new Promise((r) => setTimeout(r, 300));
    return rawPost(url, path, body);
  };

  const freshAddr = () => ethers.Wallet.createRandom().address;

  before(async () => {
    [deployer, treasury, customer, driver, venueOp, venueSigner] = await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    vault = await (await ethers.getContractFactory("FareVault")).deploy();
    drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);

    bridge = await startRpcBridge();
    dir = mkdtempSync(join(tmpdir(), "fare-custody-"));
    book = join(dir, "addresses.json");
    writeFileSync(book, JSON.stringify({
      settlement: settlement.target, orders: orders.target, vault: vault.target,
      forwarder: forwarder.target, drivers: drivers.target, venues: venues.target,
    }));
  });

  after(() => {
    for (const s of started) s?.close();
    bridge?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // ── the budget as a defense: /onboard, which counts its seed ──────────────

  it("stops sponsoring once the window's budget is spent", async () => {
    // /onboard records `cost + ONBOARD_SEED` — the seed itself is the subsidy,
    // not just the gas to move it. At a 2 PAS seed a 3 PAS budget buys exactly
    // one, and the second must be declined rather than paid.
    const { url } = await startRelay("onboard-budget", {
      ONBOARD_ENABLED: "on", ONBOARD_SEED_PAS: "2", RELAY_GAS_BUDGET_PAS: "3",
    });

    const first = await post(url, "/onboard", { address: freshAddr(), role: "driver" });
    expect(first.status).to.equal(200);
    expect((await first.json()).seeded).to.equal(true);

    const second = await post(url, "/onboard", { address: freshAddr(), role: "driver" });
    expect(second.status, "the budget did not stop the second seed").to.equal(402);
    const body = await second.json();
    expect(body.declined).to.equal(true);
    expect(body.error).to.match(/onboarding budget exhausted/);
    expect(body.action).to.equal("onboard");
  });

  it("a declined sponsorship spends nothing at all", async () => {
    // 402 has to mean "no transaction", not "a transaction that failed". If a
    // decline still burned gas, the budget would be a throttle on a leak rather
    // than a stop, and an attacker could drain the key on declines alone.
    const { url, wallet } = await startRelay("decline-costs-nothing", {
      ONBOARD_ENABLED: "on", ONBOARD_SEED_PAS: "2", RELAY_GAS_BUDGET_PAS: "0",
    });

    const before = await ethers.provider.getBalance(wallet.address);
    const target = freshAddr();
    const res = await post(url, "/onboard", { address: target, role: "driver" });

    expect(res.status).to.equal(402);
    expect(await ethers.provider.getBalance(wallet.address), "a decline moved the relay's balance").to.equal(before);
    expect(await ethers.provider.getBalance(target), "a decline still seeded the address").to.equal(0n);
  });

  it("the budget window rolls forward, and not early", async () => {
    // The window is what makes the budget a rate rather than a lifetime cap. It
    // has to reset — an operator refills daily, not never — and it has to not
    // reset early, or the cap means nothing.
    const WINDOW_MS = 2_000;
    const { url } = await startRelay("window-roll", {
      ONBOARD_ENABLED: "on", ONBOARD_SEED_PAS: "2", RELAY_GAS_BUDGET_PAS: "3",
      RELAY_BUDGET_WINDOW_MS: String(WINDOW_MS),
    });

    expect((await post(url, "/onboard", { address: freshAddr(), role: "driver" })).status).to.equal(200);
    // Still inside the window (the 300 ms spacing in `post` is well under it).
    expect((await post(url, "/onboard", { address: freshAddr(), role: "driver" })).status,
      "the window reset early").to.equal(402);

    await new Promise((r) => setTimeout(r, WINDOW_MS + 500));
    expect((await post(url, "/onboard", { address: freshAddr(), role: "driver" })).status,
      "the window never reset — the budget is a lifetime cap").to.equal(200);
  });

  // ── the budget as a defense: /fund, which does not count what it sends ────

  it("does NOT bound what /fund pays out — only the gas to pay it", async () => {
    // TEST-FINDINGS #19, and the reason C2 exists.
    //
    // /fund ends `recordBudget(cost)`, where `cost` is the gas of a plain
    // transfer. /onboard, three handlers down, ends `recordBudget(cost +
    // ONBOARD_SEED)` with the comment "the seed itself is the subsidy, not just
    // gas". /fund sends FUND_AMOUNT and records none of it.
    //
    // So the rolling budget bounds /fund by a number ~5 orders of magnitude
    // below what /fund actually costs the relay, and the real limit on the
    // faucet is the relay's balance.
    const FUND = 5;
    const BUDGET = "1";
    const { url, wallet } = await startRelay("fund-uncounted", {
      FUND_AMOUNT_PAS: String(FUND), FUND_MIN_PAS: "2", RELAY_GAS_BUDGET_PAS: BUDGET,
    }, 1_000);

    const before = await ethers.provider.getBalance(wallet.address);
    const N = 8;
    for (let i = 0; i < N; i++) {
      const res = await post(url, "/fund", { address: freshAddr() });
      expect(res.status, `/fund #${i + 1} was refused`).to.equal(200);
      expect((await res.json()).funded).to.equal(true);
    }
    const spent = before - (await ethers.provider.getBalance(wallet.address));

    // Every one of them went through, and the outflow is a large multiple of the
    // budget that was supposed to bound the window.
    expect(spent).to.be.greaterThan(PAS(FUND * N * 0.99));
    expect(spent, "the budget bounded the payout — #19 is fixed, update this test")
      .to.be.greaterThan(PAS(BUDGET) * 10n);

    // And it is still not exhausted, because only gas was ever counted.
    const next = await post(url, "/fund", { address: freshAddr() });
    expect(next.status, "the budget stopped /fund — #19 is fixed, update this test").to.equal(200);

    // What WOULD have stopped it: the balance floor. Nothing else did.
    console.log(`\n      /fund: ${N} calls moved ${ethers.formatEther(spent)} PAS `
      + `against a declared ${BUDGET} PAS/window subsidy budget`);
  });

  it("still refuses to sponsor below its own balance floor", async () => {
    // The floor is what actually stops the faucet today, so it had better hold:
    // a relay that cannot cover FUND_AMOUNT reports 503 for an operator refill
    // rather than submitting a transaction it cannot pay for.
    const { url, wallet } = await startRelay("balance-floor", {
      FUND_AMOUNT_PAS: "5", FUND_MIN_PAS: "2", RELAY_GAS_BUDGET_PAS: "1000",
    }, 1_000);

    await setBalance(wallet.address, PAS("0.5")); // below FUND_AMOUNT
    const res = await post(url, "/fund", { address: freshAddr() });

    expect(res.status).to.equal(503);
    expect((await res.json()).error).to.match(/out of gas budget|operator refill/);
  });

  // ── the budget under concurrency ──────────────────────────────────────────

  it("holds the budget when requests arrive together", async () => {
    // TEST-FINDINGS #20, now fixed. The check and the accounting used to sit on
    // either side of an awaited submission, so every request already in flight
    // tested against the same pre-spend total: three concurrent seeds all passed
    // a budget that fits one, and 6 PAS left a 3 PAS window.
    //
    // /onboard is what makes this measurable — it is the endpoint whose recorded
    // cost is large enough to see, since it counts the seed and not just the gas
    // to move it.
    const { url, wallet } = await startRelay("budget-concurrent", {
      ONBOARD_ENABLED: "on", ONBOARD_SEED_PAS: "2", RELAY_GAS_BUDGET_PAS: "3",
    });

    const before = await ethers.provider.getBalance(wallet.address);
    const targets = [freshAddr(), freshAddr(), freshAddr()];
    const results = await Promise.all(targets.map((address) => rawPost(url, "/onboard", { address, role: "driver" })));
    const seeded = results.filter((r) => r.status === 200).length;
    const spent = before - (await ethers.provider.getBalance(wallet.address));

    // The same verdict as arriving one at a time: one seed fits a 3 PAS budget.
    expect(seeded, "the budget overshot under concurrency").to.equal(1);
    expect(spent, "more value left than the window allows").to.be.lessThanOrEqual(PAS(3));

    // And the refusals are refusals, not errors — a caller can tell the
    // difference between "the relay is out of subsidy" and "the relay broke".
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).to.equal(402);
      expect((await r.json()).error).to.match(/onboarding budget exhausted/);
    }
    // Exactly one address holds a seed; the others are untouched.
    const funded = await Promise.all(targets.map((t) => ethers.provider.getBalance(t)));
    expect(funded.filter((b) => b > 0n)).to.have.length(1);
  });

  it("gives the reservation back when the submission never lands", async () => {
    // The risk in reserving up front: a send that fails would consume the window
    // permanently, and enough failures would deny service without spending a
    // thing. Forced here by leaving the relay exactly ONBOARD_SEED — past the
    // balance floor, short of seed + gas — so the transfer is rejected on
    // submission.
    const { url, wallet } = await startRelay("reservation-released", {
      ONBOARD_ENABLED: "on", ONBOARD_SEED_PAS: "2", RELAY_GAS_BUDGET_PAS: "3",
    });

    await setBalance(wallet.address, PAS(2)); // = ONBOARD_SEED, so no room for gas
    const failed = await post(url, "/onboard", { address: freshAddr(), role: "driver" });
    expect(failed.status, "expected the seed transfer to fail, not succeed").to.be.gte(400);
    expect(failed.status, "a failed send should not read as a budget decline").to.not.equal(402);

    // Refill and retry: the window must still have room for one seed. If the
    // failure had kept its reservation, 2 of the 3 PAS would be gone and this
    // would come back 402.
    await setBalance(wallet.address, PAS(1_000));
    const ok = await post(url, "/onboard", { address: freshAddr(), role: "driver" });
    expect(ok.status, "a failed submission permanently consumed budget").to.equal(200);
    expect((await ok.json()).seeded).to.equal(true);
  });

  it("the guard declines an unprofitable withdrawal rather than subsidising it", async () => {
    // The F8 bargain in its refusing form: withdrawFeeBps is 0 here, so the
    // relay earns nothing for a withdrawal and must decline. 402, not a burned
    // key — and the balance must still be the account's to withdraw.
    const { url } = await startRelay("withdraw-decline", { RELAY_GAS_BUDGET_PAS: "1000" });

    await vault.setAuthorized(deployer.address, true);
    await vault.credit(driver.address, { value: PAS(3) });
    expect(await vault.withdrawFeeBps()).to.equal(0);

    const recipient = freshAddr();
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const signature = await driver.signTypedData(
      { name: "FareVault", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: vault.target },
      { Withdraw: [
        { name: "account", type: "address" }, { name: "recipient", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { account: driver.address, recipient, nonce: await vault.withdrawNonce(driver.address), deadline }
    );

    const res = await post(url, "/withdraw", { account: driver.address, recipient, deadline, signature });
    expect(res.status).to.equal(402);
    expect((await res.json()).declined).to.equal(true);
    expect(await vault.balanceOf(driver.address), "declined, but the balance moved").to.equal(PAS(3));
    expect(await ethers.provider.getBalance(recipient)).to.equal(0n);
  });
});
