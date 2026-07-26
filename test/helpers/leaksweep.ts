import { ethers } from "hardhat";

// A leak sweep: run a protocol lifecycle, then check that a set of secrets
// appears in NOTHING the chain recorded (TEST-PLAN B1).
//
// The privacy suites already assert on raw calldata in places, but each does it
// by hand for one value in one transaction. That scales badly and, worse, it
// only ever covers the transaction whose leak someone already thought of. This
// scans every block in a range — every transaction's calldata, every log's data
// and topics — so a secret that escapes through a path nobody considered is
// still caught.
//
// The matcher is only worth as much as its encodings, which is why `present()`
// exists alongside `absent()`: a sweep that cannot find a value it was told to
// look for proves nothing when it reports finding none (TEST-PLAN B2).

export type Secret = {
  name: string;
  /// bigint → searched in every plausible on-chain encoding (see `fragments`).
  /// string → treated as hex (an address, a commitment, a salt) and matched raw.
  value: bigint | string;
};

export type Hit = { secret: string; where: string; fragment: string };

/// Every encoding a value could plausibly take in calldata or a log.
///
/// The minimal-width form is the sensitive one: ABI encoding left-pads with
/// zeroes, so a uint256 slot containing 0x240f2c4 literally contains the
/// substring "240f2c4". Searching for the minimal form therefore catches the
/// padded form too, and catches packed encodings the padded form would miss.
/// Negative values are sign-extended rather than padded, so they get their
/// two's-complement forms at both int32 and int256 width.
export function fragments(value: bigint | string): string[] {
  if (typeof value === "string") {
    const hex = value.replace(/^0x/, "").toLowerCase();
    return hex.length ? [hex] : [];
  }
  const out = new Set<string>();
  if (value >= 0n) {
    out.add(value.toString(16));
    out.add(value.toString(16).padStart(64, "0"));
  } else {
    out.add(BigInt.asUintN(32, value).toString(16).padStart(8, "0"));
    out.add(BigInt.asUintN(256, value).toString(16).padStart(64, "0"));
  }
  return [...out].filter((f) => f.length > 0);
}

type Record = { where: string; blob: string };

export class LeakSweep {
  private toBlock: number | null = null;
  private constructor(private readonly fromBlock: number) {}

  /// Begin recording. Everything mined from the NEXT block onward is in scope.
  static async start(): Promise<LeakSweep> {
    return new LeakSweep(await ethers.provider.getBlockNumber());
  }

  /// Close the window. Without this a sweep runs to the current head every time
  /// it is queried, so a later test that deliberately plants one of the same
  /// secrets — exactly what the B2 controls do — would retroactively fail an
  /// earlier absence claim. Freeze the range as soon as the run being measured
  /// is over.
  async stop(): Promise<this> {
    this.toBlock = await ethers.provider.getBlockNumber();
    return this;
  }

  /// Every searchable blob the chain recorded in the window: transaction
  /// calldata, plus each log's data and topics.
  async collect(): Promise<Record[]> {
    const to = this.toBlock ?? (await ethers.provider.getBlockNumber());
    const records: Record[] = [];
    for (let n = this.fromBlock + 1; n <= to; n++) {
      const block = await ethers.provider.getBlock(n, true);
      if (!block) continue;
      for (const hash of block.transactions) {
        const tx = await ethers.provider.getTransaction(hash);
        if (tx?.data && tx.data !== "0x") {
          records.push({ where: `calldata ${hash.slice(0, 10)} (block ${n})`, blob: tx.data.toLowerCase() });
        }
        const rc = await ethers.provider.getTransactionReceipt(hash);
        for (const [i, log] of (rc?.logs ?? []).entries()) {
          records.push({
            where: `log ${i} of ${hash.slice(0, 10)} (block ${n})`,
            blob: (log.data + log.topics.join("")).toLowerCase(),
          });
        }
      }
    }
    return records;
  }

  private async hits(secrets: Secret[]): Promise<Hit[]> {
    const records = await this.collect();
    const found: Hit[] = [];
    for (const s of secrets) {
      for (const fragment of fragments(s.value)) {
        for (const r of records) {
          if (r.blob.includes(fragment)) found.push({ secret: s.name, where: r.where, fragment });
        }
      }
    }
    return found;
  }

  /// Assert none of these secrets reached the chain, in any encoding.
  async absent(secrets: Secret[]): Promise<void> {
    const found = await this.hits(secrets);
    if (found.length) {
      const lines = found.map((h) => `  • ${h.secret} leaked into ${h.where} (as ${h.fragment.slice(0, 24)}…)`);
      throw new Error(`leak sweep found ${found.length} exposure(s):\n${lines.join("\n")}`);
    }
  }

  /// The control (B2). Assert the sweep CAN see this value — used on things the
  /// protocol publishes deliberately, so that `absent()` reporting nothing is
  /// evidence about the chain rather than about a broken matcher.
  async present(secrets: Secret[]): Promise<void> {
    const found = await this.hits(secrets);
    const missing = secrets.filter((s) => !found.some((h) => h.secret === s.name));
    if (missing.length) {
      throw new Error(
        `leak sweep is blind: expected to find ${missing.map((m) => m.name).join(", ")} ` +
        `but the matcher located none of them — absent() cannot be trusted`
      );
    }
  }
}
