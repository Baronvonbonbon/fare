import { expect } from "chai";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Proof-cost snapshot (TEST-PLAN A4).
//
// ZK artifacts have a cost that gas measurement never sees: bytes a user has to
// download, and a hard 25 MiB per-asset ceiling on Cloudflare Pages. That
// ceiling has already bitten once — the 32.8 MiB withdraw proving key could not
// be published at all and had to be split across three parts (PR #6). It was
// found at deploy time. This is so the next one is found in review.
//
// Regenerate after a deliberate circuit or artifact change:
//
//   UPDATE_PROOF_SNAPSHOT=1 npx hardhat test test/proof-cost.test.ts
//
// and commit the diff. Sizes are exact, not toleranced: these are committed
// binaries, so a byte change means someone regenerated a key and the review
// should say so.
//
// Proving TIME is deliberately not gated here. It varies several-fold across
// machines, so a threshold loose enough for CI would catch nothing and one
// tight enough to matter would flake. The live e2e runs measure it against real
// hardware instead (docs/E2E-PRIVACY-ZK.md).

const ROOT = join(__dirname, "..");
const SNAPSHOT = join(ROOT, "proof-cost.json");
const UPDATE = process.env.UPDATE_PROOF_SNAPSHOT === "1";

/// Cloudflare Pages refuses any single asset above this. Not a snapshot — a
/// limit imposed from outside, which is why it is asserted absolutely.
const PAGES_ASSET_LIMIT = 25 * 1024 * 1024;

const esmImport = new Function("u", "return import(u)") as (u: string) => Promise<any>;

const SERVED_DIRS = ["web/public/zk", "web/public/shield"];
const MiB = (n: number) => (n / 1024 / 1024).toFixed(2) + " MiB";

function servedArtifacts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dir of SERVED_DIRS) {
    for (const f of readdirSync(join(ROOT, dir)).sort()) {
      out[`${dir}/${f}`] = statSync(join(ROOT, dir, f)).size;
    }
  }
  return out;
}

const baseline: any = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : {};
const measured: any = {};

describe("proof cost", () => {
  // ── the ceiling that already broke a deploy ───────────────────────────────

  it("no served artifact exceeds the 25 MiB Cloudflare Pages limit", () => {
    // The absolute check. A circuit change that pushes an asset over this makes
    // the app unpublishable, and the failure surfaces at deploy unless it
    // surfaces here.
    const over = Object.entries(servedArtifacts())
      .filter(([, size]) => size > PAGES_ASSET_LIMIT)
      .map(([f, size]) => `${f} is ${MiB(size)}`);
    expect(over, `assets over the Pages ceiling:\n  ${over.join("\n  ")}`).to.deep.equal([]);
  });

  it("the withdraw key still needs splitting, and its parts reassemble", async () => {
    // Two directions at once. The manifest must describe the parts exactly —
    // the client trusts it to rebuild a 32.8 MiB proving key — and the whole
    // must still exceed the ceiling, because if a circuit change ever brings it
    // under, the split is dead weight and should be removed deliberately.
    const manifest = JSON.parse(readFileSync(join(ROOT, "web/public/shield/withdraw_v7.zkey.json"), "utf8"));

    let sum = 0;
    for (const part of manifest.parts) {
      const size = statSync(join(ROOT, "web/public/shield", part.name)).size;
      expect(size, `${part.name} size drifted from the manifest`).to.equal(part.bytes);
      expect(size, `${part.name} is itself over the ceiling`).to.be.at.most(PAGES_ASSET_LIMIT);
      sum += size;
    }
    expect(sum, "parts do not sum to the declared whole").to.equal(manifest.bytes);
    expect(manifest.bytes, "the key now fits under the ceiling — the split can go").to.be.greaterThan(PAGES_ASSET_LIMIT);

    // And the digest the client verifies against actually matches the bytes.
    const rebuilt = Buffer.concat(
      manifest.parts.map((p: any) => readFileSync(join(ROOT, "web/public/shield", p.name)))
    );
    expect(createHash("sha256").update(rebuilt).digest("hex")).to.equal(manifest.sha256);

    // The shipped loader agrees — it re-checks length and digest on every boot.
    const { loadWithdrawZkey } = await esmImport(
      pathToFileURL(join(ROOT, "scripts", "shield", "zkey.mjs")).href
    );
    expect(loadWithdrawZkey().length).to.equal(manifest.bytes);

    measured.withdrawKeyBytes = manifest.bytes;
    measured.withdrawParts = manifest.parts.length;
  });

  // ── the snapshot ──────────────────────────────────────────────────────────

  it("served artifact sizes match the committed snapshot", () => {
    const sizes = servedArtifacts();
    measured.artifacts = sizes;
    if (UPDATE) return;

    expect(baseline.artifacts, "no baseline — run UPDATE_PROOF_SNAPSHOT=1").to.be.an("object");
    const drift: string[] = [];
    for (const [f, size] of Object.entries(sizes)) {
      const was = baseline.artifacts[f];
      if (was === undefined) drift.push(`${f} is new (${MiB(size)})`);
      else if (was !== size) {
        // Exact bytes, not just MiB: a few-KB regeneration rounds to the same
        // MiB figure and the message would read "4.38 MiB → 4.38 MiB".
        const delta = size - was;
        drift.push(`${f}: ${was} → ${size} bytes (${delta > 0 ? "+" : ""}${delta}, ${MiB(was)} → ${MiB(size)})`);
      }
    }
    for (const f of Object.keys(baseline.artifacts)) {
      if (!(f in sizes)) drift.push(`${f} was removed`);
    }
    expect(drift, `artifact sizes changed:\n  ${drift.join("\n  ")}`).to.deep.equal([]);
  });

  // ── the circuits' public interface ────────────────────────────────────────

  it("each circuit's public signal count is unchanged", () => {
    // nPublic is the circuit's ABI. Changing it silently invalidates every
    // verifier already deployed with a lock-once VK, so it must be a visible,
    // reviewed diff rather than something noticed on-chain.
    const circuits: Record<string, any> = {};
    for (const [name, vkFile, calldataFile] of [
      ["proximity", "vk.json", "setVK-calldata.json"],
      ["shieldnote", "shieldnote-vk.json", "setShieldVK-calldata.json"],
    ] as const) {
      const vk = JSON.parse(readFileSync(join(ROOT, "circuits", "build", vkFile), "utf8"));
      const calldata = JSON.parse(readFileSync(join(ROOT, "circuits", "build", calldataFile), "utf8"));
      const icCount = Object.keys(calldata).filter((k) => /^IC\d+$/.test(k)).length;

      expect(vk.protocol, `${name} is not groth16`).to.equal("groth16");
      expect(vk.curve, `${name} is not on bn128`).to.equal("bn128");
      // The two committed representations must agree: the VK the setter is
      // called with carries one IC point per public signal, plus IC0.
      expect(icCount, `${name}: calldata has ${icCount} IC points for nPublic=${vk.nPublic}`)
        .to.equal(vk.nPublic + 1);

      circuits[name] = { nPublic: vk.nPublic, curve: vk.curve, protocol: vk.protocol };
    }
    measured.circuits = circuits;
    if (UPDATE) return;

    expect(baseline.circuits, "no baseline — run UPDATE_PROOF_SNAPSHOT=1").to.be.an("object");
    expect(circuits).to.deep.equal(baseline.circuits);
  });

  after(() => {
    if (!UPDATE) return;
    const out = {
      artifacts: measured.artifacts,
      circuits: measured.circuits,
      withdrawKeyBytes: measured.withdrawKeyBytes,
      withdrawParts: measured.withdrawParts,
      pagesAssetLimit: PAGES_ASSET_LIMIT,
    };
    writeFileSync(SNAPSHOT, JSON.stringify(out, null, 2) + "\n");
    console.log(`\n  proof-cost snapshot written → proof-cost.json`);
    for (const [f, size] of Object.entries(out.artifacts as Record<string, number>)) {
      console.log(`    ${f.padEnd(38)} ${MiB(size).padStart(10)}`);
    }
    for (const [n, c] of Object.entries(out.circuits as Record<string, any>)) {
      console.log(`    circuit ${n.padEnd(30)} nPublic=${c.nPublic}`);
    }
  });
});
