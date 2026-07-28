import { expect } from "chai";
import { ethers } from "hardhat";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Access-control matrix (TEST-PLAN C3). Every gated state-changing function,
// called as every role that should NOT be able to call it.
//
// The individual suites already prove the happy paths, and several already
// assert one or two denials. What none of them can do is guarantee COVERAGE:
// a modifier dropped during an upgrade breaks no existing test, because no
// existing test calls that function as the wrong caller. So the table below is
// checked for completeness against the contracts themselves — a new
// modifier-gated function that nobody adds here fails the last test in this
// file.
//
// Denials are matched against the specific authorization error, not merely
// "it reverted". That distinction is the whole rigor of this file: a call that
// reverts because the arguments were nonsense would otherwise pass as if
// authorization had held.

const PAS = (n: string | number) => ethers.parseEther(String(n));
const A1 = "0x1111111111111111111111111111111111111111";
const B32 = "0x" + "22".repeat(32);

type Role =
  | "owner" | "router" | "settlement" | "disputes"
  | "authorized" | "operator" | "keeper" | "arbiter" | "guardian" | "stranger";

const ALL_ROLES: Role[] = [
  "owner", "router", "settlement", "disputes",
  "authorized", "operator", "keeper", "arbiter", "guardian", "stranger",
];

// Revert data is decoded here rather than read off Hardhat's inferred message:
// some of these reverts come back as "couldn't infer the reason", and a matrix
// that cannot tell an authorization failure from any other failure is worthless.
const ERROR_STRING = "0x08c379a0"; // Error(string)
const PANIC = "0x4e487b71";
const OWNABLE_UNAUTH = ethers.id("OwnableUnauthorizedAccount(address)").slice(0, 10);

function decodeRevert(data: string | undefined): string {
  if (!data || data === "0x") return "(no revert data)";
  if (data.startsWith(ERROR_STRING)) {
    try { return ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0]; }
    catch { return "(undecodable Error)"; }
  }
  if (data.startsWith(PANIC)) return `Panic(${BigInt("0x" + data.slice(10))})`;
  if (data.startsWith(OWNABLE_UNAUTH)) return "OwnableUnauthorizedAccount";
  return `custom ${data.slice(0, 10)}`;
}

/// Exactly the errors that mean "you are not allowed", and nothing else.
const AUTH_ERROR =
  /^(OwnableUnauthorizedAccount|not-authorized|not-router|not-disputes|not-settlement|not-operator|not-keeper|not-arbiter|not-owner)$/;

type Entry = { c: string; fn: string; args: any[]; allow: Role[] };

// The matrix. `args` only has to type-check: every authorization check runs
// before any argument validation, so a denied call reverts on auth whatever
// the arguments are.
const MATRIX: Entry[] = [
  // ── FareOrders ──────────────────────────────────────────────────────────
  { c: "orders", fn: "setRouter", args: [A1], allow: ["owner"] },
  { c: "orders", fn: "configure", args: [A1, A1, A1, A1, A1, A1], allow: ["owner"] },
  { c: "orders", fn: "setParams", args: [250, 2500, 3600, 3600], allow: ["owner"] },
  { c: "orders", fn: "setRelayRebateBps", args: [2000], allow: ["owner"] },
  { c: "orders", fn: "setRelayServiceFee", args: [ethers.ZeroAddress, 0], allow: ["owner"] },
  { c: "orders", fn: "setAcceptedToken", args: [A1, true], allow: ["owner"] },
  { c: "orders", fn: "onPickupConfirmed", args: [1], allow: ["settlement"] },
  { c: "orders", fn: "onDropoffConfirmed", args: [1, A1], allow: ["settlement"] },
  { c: "orders", fn: "markDisputed", args: [1], allow: ["disputes"] },
  { c: "orders", fn: "resolveDisputed", args: [1, 5000], allow: ["disputes"] },

  // ── FareVault ───────────────────────────────────────────────────────────
  { c: "vault", fn: "setWithdrawFeeBps", args: [100], allow: ["owner"] },
  { c: "vault", fn: "setRouter", args: [A1], allow: ["owner"] },
  { c: "vault", fn: "setShieldPool", args: [A1], allow: ["owner"] },
  { c: "vault", fn: "setShieldBuckets", args: [[PAS(1)]], allow: ["owner"] },
  { c: "vault", fn: "setShieldVerifier", args: [A1], allow: ["owner"] },
  { c: "vault", fn: "setShieldPoseidon", args: [A1], allow: ["owner"] },
  { c: "vault", fn: "setAuthorized", args: [A1, true], allow: ["owner"] },
  { c: "vault", fn: "creditToken", args: [A1, A1, 1], allow: ["authorized"] },

  // ── FareDrivers ─────────────────────────────────────────────────────────
  { c: "drivers", fn: "setRouter", args: [A1], allow: ["owner"] },
  { c: "drivers", fn: "importRecords", args: [A1, [A1]], allow: ["owner"] },
  { c: "drivers", fn: "setAuthorized", args: [A1, true], allow: ["owner"] },
  { c: "drivers", fn: "setMinStake", args: [PAS(1)], allow: ["owner"] },
  { c: "drivers", fn: "setUnbondingSeconds", args: [3600], allow: ["owner"] },
  { c: "drivers", fn: "setBanned", args: [A1, true], allow: ["owner"] },
  { c: "drivers", fn: "recordDelivered", args: [A1], allow: ["authorized"] },
  { c: "drivers", fn: "recordFailed", args: [A1], allow: ["authorized"] },
  { c: "drivers", fn: "slash", args: [A1, 1, A1], allow: ["authorized"] },

  // ── FareVenues ──────────────────────────────────────────────────────────
  { c: "venues", fn: "setAuthorized", args: [A1, true], allow: ["owner"] },
  { c: "venues", fn: "setRouter", args: [A1], allow: ["owner"] },
  { c: "venues", fn: "importVenues", args: [A1, [1]], allow: ["owner"] },
  { c: "venues", fn: "setSigner", args: [1, A1], allow: ["operator"] },
  { c: "venues", fn: "setPayout", args: [1, A1], allow: ["operator"] },
  { c: "venues", fn: "setActive", args: [1, false], allow: ["operator"] },
  { c: "venues", fn: "setLocation", args: [1, 1, 1], allow: ["operator"] },
  { c: "venues", fn: "setMetadata", args: [1, "ipfs://x"], allow: ["operator"] },
  { c: "venues", fn: "recordPickup", args: [1], allow: ["authorized"] },

  // ── FareSettlement ──────────────────────────────────────────────────────
  { c: "settlement", fn: "setRouter", args: [A1], allow: ["owner"] },
  { c: "settlement", fn: "configure", args: [A1, A1], allow: ["owner"] },
  { c: "settlement", fn: "setLocationVerifier", args: [A1], allow: ["owner"] },
  { c: "settlement", fn: "setGeoParams", args: [100, 100, 300, 60], allow: ["owner"] },

  // ── FareDisputes ────────────────────────────────────────────────────────
  { c: "disputes", fn: "setRouter", args: [A1], allow: ["owner"] },
  { c: "disputes", fn: "configure", args: [A1, A1, A1, A1], allow: ["owner"] },
  { c: "disputes", fn: "setArbiter", args: [A1], allow: ["owner"] },
  { c: "disputes", fn: "setDisputeBond", args: [0], allow: ["owner"] },
  { c: "disputes", fn: "resolve", args: [1, 5000, false, false, 0], allow: ["arbiter"] },

  // ── FareRatings ─────────────────────────────────────────────────────────
  { c: "ratings", fn: "setRouter", args: [A1], allow: ["owner"] },
  { c: "ratings", fn: "configure", args: [A1], allow: ["owner"] },

  // ── FareGovernanceRouter ────────────────────────────────────────────────
  { c: "router", fn: "register", args: [B32, A1], allow: ["owner"] },
  { c: "router", fn: "upgradeContract", args: [B32, A1, false], allow: ["owner"] },
  { c: "router", fn: "setContractFrozen", args: [B32, A1, true], allow: ["owner"] },

  // ── FarePauseRegistry ───────────────────────────────────────────────────
  { c: "pause", fn: "setGuardian", args: [A1, true], allow: ["owner"] },
  { c: "pause", fn: "unpause", args: [0], allow: ["owner"] },
  // the one deliberately two-role gate: guardians stop the bleeding, owner resumes
  { c: "pause", fn: "pause", args: [0], allow: ["owner", "guardian"] },

  // ── verifiers ───────────────────────────────────────────────────────────
  { c: "locVerifier", fn: "setVerifyingKey", args: Array(10).fill(0).map((_, i) => (i === 0 || i > 3 ? [0, 0] : [0, 0, 0, 0])), allow: ["owner"] },
  { c: "shieldVerifier", fn: "setVerifyingKey", args: Array(9).fill(0).map((_, i) => (i === 0 || i > 3 ? [0, 0] : [0, 0, 0, 0])), allow: ["owner"] },
];

/// Every modifier-gated state-changing function, read from the contracts. The
/// completeness check compares this to the matrix, so the table cannot silently
/// fall behind the code.
function gatedFromSource(): { file: string; fn: string; gate: string }[] {
  const GATES = ["onlyOwner", "onlyRouter", "onlyAuthorized", "onlyDisputes", "onlySettlement", "onlyOperator"];
  const dir = join(__dirname, "..", "contracts");
  const out: { file: string; fn: string; gate: string }[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sol"))) {
    const src = readFileSync(join(dir, file), "utf8");
    for (const m of src.matchAll(/function\s+(\w+)\s*\(/g)) {
      let i = m.index! + m[0].length - 1, depth = 0, j = i;
      while (j < src.length) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
        j++;
      }
      const brace = src.indexOf("{", j);
      const tail = src.slice(j, brace === -1 ? j + 200 : brace);
      if (!/\bexternal\b|\bpublic\b/.test(tail)) continue;
      if (/\bview\b|\bpure\b/.test(tail)) continue;
      const gate = GATES.find((g) => new RegExp(`\\b${g}\\b`).test(tail));
      if (gate) out.push({ file, fn: m[1], gate });
    }
  }
  return out;
}

describe("access control matrix", () => {
  let addrOf: Record<Role, string>;
  let c: Record<string, any>;

  /// Call `fn` as `from` via eth_call and report either "ACCEPTED" or the
  /// decoded revert reason. eth_call takes an arbitrary `from`, so roles held
  /// by CONTRACTS (settlement, disputes, router) need no impersonation and no
  /// funding — they are just addresses here.
  async function callAs(entry: Entry, from: string): Promise<string> {
    const target = c[entry.c];
    const data = target.interface.encodeFunctionData(entry.fn, entry.args);
    try {
      await ethers.provider.call({ to: target.target as string, from, data });
      return "ACCEPTED";
    } catch (e: any) {
      return decodeRevert(e?.data ?? e?.info?.error?.data);
    }
  }

  before(async () => {
    const [owner, authorized, operator, keeper, arbiter, guardian, stranger] = await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    const ratings = await (await ethers.getContractFactory("FareRatings")).deploy(forwarder.target);
    const router = await (await ethers.getContractFactory("FareGovernanceRouter")).deploy();
    const locVerifier = await (await ethers.getContractFactory("FareLocationVerifier")).deploy();
    const shieldVerifier = await (await ethers.getContractFactory("FareShieldVerifier")).deploy();

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, owner.address);
    await disputes.configure(orders.target, vault.target, drivers.target, owner.address);
    await settlement.configure(orders.target, venues.target);

    // Each non-owner role goes to a DIFFERENT account, so "authorized is denied
    // on an owner-gated call" is a real assertion rather than an artifact of one
    // address holding everything.
    await vault.setAuthorized(authorized.address, true);
    await drivers.setAuthorized(authorized.address, true);
    await venues.setAuthorized(authorized.address, true);
    await disputes.setArbiter(arbiter.address);
    await pause.setGuardian(guardian.address, true);
    await venues.connect(operator).registerVenue(37_774_900, -122_419_400, operator.address, operator.address, "ipfs://v");

    addrOf = {
      owner: owner.address, authorized: authorized.address, operator: operator.address,
      keeper: keeper.address, arbiter: arbiter.address, guardian: guardian.address,
      stranger: stranger.address,
      settlement: settlement.target as string,
      disputes: disputes.target as string,
      router: router.target as string,
    };
    c = { orders, vault, drivers, venues, settlement, disputes, ratings, router, pause, locVerifier, shieldVerifier };
  });

  // ── the sweep ─────────────────────────────────────────────────────────────

  it("every gated function rejects every role that should not hold it", async () => {
    const failures: string[] = [];
    let checked = 0;

    for (const e of MATRIX) {
      for (const role of ALL_ROLES) {
        if (e.allow.includes(role)) continue;
        checked++;
        const got = await callAs(e, addrOf[role]);
        if (got === "ACCEPTED") {
          failures.push(`${e.c}.${e.fn} ACCEPTED a call from "${role}" (allowed: ${e.allow.join("|")})`);
        } else if (!AUTH_ERROR.test(got)) {
          // It reverted, but not on authorization — so the denial proves
          // nothing about access control, and the matrix arguments need fixing.
          failures.push(`${e.c}.${e.fn} as "${role}" reverted on "${got}", not on auth`);
        }
      }
    }

    expect(failures, `${failures.length} of ${checked} role checks failed:\n  ${failures.join("\n  ")}`)
      .to.deep.equal([]);
    expect(checked).to.be.greaterThan(400); // the sweep is actually sweeping
  });

  // ── the other half: the permitted role gets past the gate ────────────────

  it("the permitted role is never stopped by authorization", async () => {
    // Without this the sweep above would still pass on a function that is
    // broken for everyone. The assertion is deliberately narrow: the allowed
    // caller must not be refused by the ACCESS CHECK. It may still revert on
    // state — `disputes.resolve` as the arbiter hits "bad-status" because no
    // dispute exists — and that is a different question, owned by the suites
    // that drive those flows.
    const failures: string[] = [];
    let checked = 0;

    for (const e of MATRIX) {
      for (const role of e.allow) {
        checked++;
        const got = await callAs(e, addrOf[role]);
        if (got !== "ACCEPTED" && AUTH_ERROR.test(got)) {
          failures.push(`${e.c}.${e.fn} refused its OWN role "${role}" with "${got}"`);
        }
      }
    }

    expect(failures, failures.join("\n  ")).to.deep.equal([]);
    expect(checked).to.be.greaterThan(55);
  });

  // ── the guarantee that keeps this file honest ─────────────────────────────

  it("the matrix covers every modifier-gated function in the contracts", () => {
    // This is the point of the whole file. A modifier dropped — or a new gated
    // function added — breaks no other test, because no other test calls that
    // function as the wrong caller. It breaks this one.
    const inMatrix = new Set(MATRIX.map((e) => e.fn));
    const gated = gatedFromSource();
    const missing = gated.filter((g) => !inMatrix.has(g.fn)).map((g) => `${g.file}:${g.fn} (${g.gate})`);

    expect(missing, `gated functions with no entry in MATRIX:\n  ${missing.join("\n  ")}`).to.deep.equal([]);
    expect(gated.length, "the source parser found nothing — it has drifted").to.be.greaterThan(45);
  });
});
