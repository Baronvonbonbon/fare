// Per-payer cost accounting for a delivery (TEST-PLAN A3).
//
// Extracted from measure-costs.mjs so both modes can share it: the live Paseo
// run through real relays, and the local-chain run that gates in CI. The point
// of a ledger rather than a total is WHO PAYS — a change that quietly moves a
// cost from the relay onto the customer does not alter the sum, and a single
// aggregate would hide it completely.
//
// Pure: no chain, no I/O. Callers hand it gas, price and revenue; it does the
// arithmetic and the grouping.
import { formatEther } from "ethers";

/// One recorded transaction.
/// @typedef {{ step: string, payer: string, via: string|null,
///             gasUsed: bigint, gasPrice: bigint, revenue: bigint }} Entry

export function createLedger() {
  /** @type {Entry[]} */
  const entries = [];

  return {
    /// Record a mined transaction. `revenue` is what the payer EARNED for it —
    /// zero for the subsidised paths, which is most of them.
    record({ step, payer, via = null, gasUsed, gasPrice, revenue = 0n }) {
      if (!step || !payer) throw new Error("ledger: step and payer are required");
      const g = BigInt(gasUsed), p = BigInt(gasPrice), r = BigInt(revenue);
      if (g < 0n || p < 0n) throw new Error("ledger: gas and price must be non-negative");
      entries.push({ step, payer, via, gasUsed: g, gasPrice: p, revenue: r });
      return entries[entries.length - 1];
    },

    get length() { return entries.length; },
    rows() { return entries.map((e) => ({ ...e })); },

    /// Everything a payer spent, earned, and netted.
    byPayer() {
      /** @type {Record<string, {txs:number, cost:bigint, revenue:bigint, net:bigint}>} */
      const out = {};
      for (const e of entries) {
        const cost = e.gasUsed * e.gasPrice;
        out[e.payer] ??= { txs: 0, cost: 0n, revenue: 0n, net: 0n };
        out[e.payer].txs += 1;
        out[e.payer].cost += cost;
        out[e.payer].revenue += e.revenue;
        out[e.payer].net = out[e.payer].revenue - out[e.payer].cost;
      }
      return out;
    },

    /// The steps a given payer footed — the question "who pays for X" in reverse.
    stepsFor(payer) {
      return entries.filter((e) => e.payer === payer).map((e) => e.step);
    },

    /// Serializable report, identical in shape from either mode so the live and
    /// local runs can be diffed against each other.
    report(meta = {}) {
      const byPayer = this.byPayer();
      const totalCost = entries.reduce((a, e) => a + e.gasUsed * e.gasPrice, 0n);
      const totalRevenue = entries.reduce((a, e) => a + e.revenue, 0n);
      return {
        ...meta,
        totals: {
          txs: entries.length,
          costPAS: formatEther(totalCost),
          revenuePAS: formatEther(totalRevenue),
          netPAS: formatEther(totalRevenue - totalCost),
        },
        byPayer: Object.fromEntries(
          Object.entries(byPayer).map(([k, v]) => [k, {
            txs: v.txs,
            costPAS: formatEther(v.cost),
            revenuePAS: formatEther(v.revenue),
            netPAS: formatEther(v.net),
          }])
        ),
        ledger: entries.map((e) => ({
          step: e.step,
          payer: e.payer,
          via: e.via,
          gasUsed: e.gasUsed.toString(),
          costPAS: formatEther(e.gasUsed * e.gasPrice),
          revenuePAS: formatEther(e.revenue),
          netPAS: formatEther(e.revenue - e.gasUsed * e.gasPrice),
        })),
      };
    },
  };
}
