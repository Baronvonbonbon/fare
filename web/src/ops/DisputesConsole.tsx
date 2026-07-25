import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { contracts, fmt, parse, short, syncAddressesFromRouter, nodeLabel } from "../chain";
import { ConsoleProps } from "./OpsApp";
import { fetchCapsules, fetchSealedChat } from "../channel";
import { openCapsule, evidenceMatches } from "../capsule";
import { openWithOrderKey } from "../msg";

// Arbiter console (integration-plan D1).
//
// The arbitrated escape hatch (FareDisputes) had no ruling UI — `resolve` was
// reachable only from a script. This is that console: see the queue of open
// disputes with their order + driver context, and issue a ruling (escrow split,
// bond outcome, reputation strike, stake slash).

const D_STATUS = ["none", "open", "resolved"]; // DisputeStatus enum
const O_STATUS = ["—", "Open", "Assigned", "PickedUp", "Delivered", "Cancelled", "Disputed", "Resolved"];

interface DisputeRow {
  id: bigint;
  orderId: bigint;
  opener: string;
  bond: bigint;
  status: number; // 1 open, 2 resolved
  evidenceURI: string;
  // joined order context
  customer: string;
  driver: string;
  escrow: bigint;
  orderValue: bigint;
  tip: bigint;
  fare: bigint;
  orderStatus: number;
  // joined driver context (0 if no driver assigned)
  driverStake: bigint;
  driverDelivered: number;
  driverFailed: number;
}

export default function DisputesConsole({ session, busy, run, say }: ConsoleProps) {
  const [arbiter, setArbiter] = useState<string | null>(null);
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await syncAddressesFromRouter(); // follow router-driven upgrades
      const c = contracts();
      setArbiter((await c.disputes.arbiter()).toLowerCase());

      const n = Number(await c.disputes.nextDisputeId());
      const ids = Array.from({ length: Math.max(0, n - 1) }, (_, i) => BigInt(i + 1));
      const raw = await Promise.all(ids.map((id) => c.disputes.disputes(id)));

      const kept = ids
        .map((id, i) => ({ id, d: raw[i] }))
        .filter((x) => Number(x.d.status) !== 0);

      const orders = await Promise.all(kept.map((x) => c.orders.orders(x.d.orderId)));
      const drivers = await Promise.all(
        orders.map((o) =>
          o.driver && o.driver !== ethers.ZeroAddress
            ? c.drivers.drivers(o.driver)
            : Promise.resolve(null)
        )
      );

      const built: DisputeRow[] = kept.map((x, i) => {
        const o = orders[i];
        const drv = drivers[i];
        return {
          id: x.id,
          orderId: x.d.orderId,
          opener: x.d.opener,
          bond: x.d.bond,
          status: Number(x.d.status),
          evidenceURI: x.d.evidenceURI,
          customer: o.customer,
          driver: o.driver,
          escrow: o.escrow,
          orderValue: o.orderValue,
          tip: o.tip,
          fare: o.fare,
          orderStatus: Number(o.status),
          driverStake: drv ? drv.stake : 0n,
          driverDelivered: drv ? Number(drv.delivered) : 0,
          driverFailed: drv ? Number(drv.failed) : 0,
        };
      });
      // Open first (actionable), newest id first within each group.
      built.sort((a, b) => (a.status - b.status) || Number(b.id - a.id));
      setRows(built);
    } catch (e: any) {
      say(`Load failed: ${e?.shortMessage ?? e?.message ?? e}`, true);
    } finally {
      setLoading(false);
    }
  }, [say]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const me = session?.address.toLowerCase() ?? null;
  const authorized = !!me && !!arbiter && me === arbiter;
  const signed = session ? contracts(session.signer) : null;

  const open = rows.filter((r) => r.status === 1);
  const resolved = rows.filter((r) => r.status === 2);

  return (
    <>
      <div className="card">
        <h2>Arbiter authority</h2>
        <div className="kv"><span className="k">on-chain arbiter</span><span className="v mono">{arbiter ? short(arbiter) : "…"}</span></div>
        <div className="kv"><span className="k">connected</span><span className="v mono">{me ? short(me) : "—"}</span></div>
        <div className="kv"><span className="k">node</span><span className="v">{nodeLabel()}</span></div>
        {session && (
          <p className="hint" style={{ color: authorized ? "var(--ok)" : "var(--err)" }}>
            {authorized
              ? "✓ This wallet is the arbiter — rulings will settle."
              : "⚠ This wallet is NOT the arbiter. resolve() will revert on-chain."}
          </p>
        )}
        {!session && <p className="hint">Connect the arbiter wallet to issue rulings.</p>}
      </div>

      <div className="card">
        <h2>
          Open disputes {open.length > 0 && <span className="tag">{open.length}</span>}
          <button className="btn small ghost" style={{ marginLeft: "auto" }} disabled={loading} onClick={refresh}>
            {loading ? "…" : "↻ refresh"}
          </button>
        </h2>
        {open.length === 0 && (
          <div className="empty">{loading ? "Loading the queue…" : "No open disputes."}</div>
        )}
        {open.map((r) => (
          <DisputeCard key={String(r.id)} r={r} authorized={authorized} busy={busy} run={run} signed={signed} refresh={refresh} />
        ))}
      </div>

      {resolved.length > 0 && (
        <div className="card">
          <h2>
            History
            <button className="btn small ghost" style={{ marginLeft: "auto" }} onClick={() => setShowResolved((v) => !v)}>
              {showResolved ? "hide" : `show (${resolved.length})`}
            </button>
          </h2>
          {showResolved &&
            resolved.map((r) => (
              <DisputeCard key={String(r.id)} r={r} authorized={authorized} busy={busy} run={run} signed={signed} refresh={refresh} />
            ))}
        </div>
      )}
    </>
  );
}


// ---------- disclosure capsules (PRIVACY-TIERS §7) ----------

/// Order messages are unreadable by default; a capsule is the arbiter's scoped
/// escape hatch. Opening one yields ONE order's thread key — not an account key,
/// and nothing about any other order.
///
/// The **fail-closed** rule does the work a ZK proof of correct encryption
/// would: the vault can't verify a capsule was honestly formed, so a party whose
/// capsule is missing or won't open has simply not disclosed, and the ruling
/// goes against them. That is a finding to act on, not an error to debug.
function DisclosurePanel({ r }: { r: DisputeRow }) {
  const [key, setKey] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [anchored, setAnchored] = useState<boolean | null>(null);
  const [disclosed, setDisclosed] = useState<{ from: string; ok: boolean }[]>([]);
  const [thread, setThread] = useState<{ from: string; ts: number; text: string }[] | null>(null);

  async function reveal() {
    setBusy(true);
    setNote("");
    try {
      const posted = await fetchCapsules(r.orderId);
      if (posted.length === 0) {
        setNote("No capsules escrowed on this order — neither party disclosed.");
        setDisclosed([]); setThread(null); setAnchored(null);
        return;
      }

      // The on-chain evidenceURI pins WHICH capsules the dispute was opened
      // over. A mismatch means the bundle was swapped after the fact, so it is
      // worth no more than an absent one.
      setAnchored(evidenceMatches(r.evidenceURI, posted.map((p) => p.capsule)));

      const outcomes: { from: string; ok: boolean }[] = [];
      let orderKey: string | null = null;
      for (const p of posted) {
        try {
          const k = await openCapsule(key.trim(), p.capsule);
          outcomes.push({ from: p.from, ok: true });
          orderKey = orderKey ?? k;
        } catch {
          outcomes.push({ from: p.from, ok: false });
        }
      }
      setDisclosed(outcomes);

      if (!orderKey) {
        setNote("No capsule opened with this key. Either it is not the arbiter key, or nothing was honestly disclosed.");
        setThread(null);
        return;
      }
      const sealed = await fetchSealedChat(r.orderId);
      const out: { from: string; ts: number; text: string }[] = [];
      for (const m of sealed) {
        try { out.push({ from: m.from, ts: m.ts, text: await openWithOrderKey(orderKey, m) }); }
        catch { out.push({ from: m.from, ts: m.ts, text: "· unreadable ·" }); }
      }
      setThread(out);
    } catch (e: any) {
      setNote(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  const verdict = (addr: string) => {
    const hit = disclosed.find((d) => d.from.toLowerCase() === addr.toLowerCase());
    if (!hit) return "no capsule — fail closed against this party";
    return hit.ok ? "disclosed ✓" : "capsule did not open — fail closed against this party";
  };

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
      <div className="section-note">Disclosure</div>
      <p className="hint">
        Opens this order&apos;s messages with the arbiter key. Scoped to this order only.
        The key is used in this tab and never stored or sent anywhere.
      </p>
      <div className="btn-row" style={{ flexWrap: "wrap" }}>
        <input style={{ flex: 1, minWidth: 200 }} type="password" placeholder="arbiter private key (0x…)"
          value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn small" disabled={busy || !key.trim()} onClick={reveal}>
          {busy ? "Opening…" : "Open capsules"}
        </button>
      </div>

      {anchored === false && (
        <p className="hint" style={{ color: "var(--danger, #f66)" }}>
          ⚠ The escrowed capsules do not match the evidence anchored on-chain — this bundle is not
          the one the dispute was opened over. Treat it as no evidence.
        </p>
      )}
      {disclosed.length > 0 && (
        <>
          <div className="kv"><span className="k">customer</span><span className="v">{verdict(r.customer)}</span></div>
          {r.driver !== ethers.ZeroAddress && (
            <div className="kv"><span className="k">driver</span><span className="v">{verdict(r.driver)}</span></div>
          )}
        </>
      )}
      {thread && (
        <div style={{ maxHeight: 200, overflowY: "auto", marginTop: 8, fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
          {thread.length === 0 && <span className="hint">Thread opened — no messages were sent.</span>}
          {thread.map((m, i) => (
            <div key={i}>
              <span className="mono" style={{ opacity: 0.7 }}>{short(m.from)}</span>{" "}
              <span>{m.text}</span>
            </div>
          ))}
        </div>
      )}
      {note && <p className="hint">{note}</p>}
    </div>
  );
}

// ---------- dispute card + ruling form ----------

function DisputeCard({
  r,
  authorized,
  busy,
  run,
  signed,
  refresh,
}: {
  r: DisputeRow;
  authorized: boolean;
  busy: boolean;
  run: ConsoleProps["run"];
  signed: any;
  refresh: () => Promise<any>;
}) {
  const openerIsCustomer = r.opener.toLowerCase() === r.customer.toLowerCase();
  const openerRole = openerIsCustomer ? "customer" : r.opener.toLowerCase() === r.driver.toLowerCase() ? "driver" : "?";

  // Ruling inputs. Neutral defaults — force a deliberate split.
  const [bps, setBps] = useState(5000);
  const [openerWins, setOpenerWins] = useState(true);
  const [driverAtFault, setDriverAtFault] = useState(false);
  const [slash, setSlash] = useState("0");

  const customerAmt = (r.escrow * BigInt(bps)) / 10_000n;
  const driverAmt = r.escrow - customerAmt;
  let slashWei = 0n;
  try {
    slashWei = parse(slash);
  } catch {
    /* keep 0 on unparseable input */
  }
  const slashOverStake = slashWei > r.driverStake;

  return (
    <div className="order">
      <div className="order-head">
        <span className="order-id">dispute #{String(r.id)} · order #{String(r.orderId)}</span>
        <span className={`badge ${r.status === 2 ? "resolved" : "disputed"}`}>{D_STATUS[r.status]}</span>
      </div>

      <div className="kv"><span className="k">opener</span><span className="v mono">{short(r.opener)} · {openerRole}</span></div>
      <div className="kv"><span className="k">bond</span><span className="v">{fmt(r.bond)} PAS</span></div>
      <div className="kv"><span className="k">order status</span><span className="v">{O_STATUS[r.orderStatus] ?? r.orderStatus}</span></div>
      <div className="kv"><span className="k">customer</span><span className="v mono">{short(r.customer)}</span></div>
      <div className="kv"><span className="k">driver</span><span className="v mono">{r.driver === ethers.ZeroAddress ? "—" : short(r.driver)}</span></div>
      <div className="kv"><span className="k">frozen escrow</span><span className="v amount">{fmt(r.escrow)} PAS</span></div>
      <div className="kv"><span className="k">value · tip · fare</span><span className="v">{fmt(r.orderValue)} · {fmt(r.tip)} · {fmt(r.fare)}</span></div>
      {r.driver !== ethers.ZeroAddress && (
        <div className="kv"><span className="k">driver rep · stake</span><span className="v">{r.driverDelivered}✓ / {r.driverFailed}✗ · {fmt(r.driverStake)} PAS</span></div>
      )}
      <div className="kv"><span className="k">evidence</span><span className="v mono">{r.evidenceURI || "(none provided)"}</span></div>

      {r.status === 1 && <DisclosurePanel r={r} />}

      {r.status === 1 && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
          <div className="section-note">Ruling</div>

          <label className="hint" style={{ display: "block", marginTop: 8 }}>
            Customer share of escrow — {(bps / 100).toFixed(0)}%
          </label>
          <input
            type="range"
            min={0}
            max={10000}
            step={100}
            value={bps}
            onChange={(e) => setBps(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <div className="kv"><span className="k">→ customer</span><span className="v amount">{fmt(customerAmt)} PAS</span></div>
          <div className="kv"><span className="k">→ driver</span><span className="v amount">{fmt(driverAmt)} PAS</span></div>

          <label className="hint" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
            <input type="checkbox" checked={openerWins} onChange={(e) => setOpenerWins(e.target.checked)} />
            Opener wins — {fmt(r.bond)} PAS bond {openerWins ? "refunded to opener" : "forfeited to treasury"}
          </label>

          <label className="hint" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <input
              type="checkbox"
              checked={driverAtFault}
              disabled={r.driver === ethers.ZeroAddress}
              onChange={(e) => setDriverAtFault(e.target.checked)}
            />
            Driver at fault — records a failed delivery (reputation strike)
          </label>

          {r.driver !== ethers.ZeroAddress && (
            <div className="row" style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
              <label className="hint" style={{ flex: 1 }}>
                Slash driver stake (PAS) → paid to customer as damages
              </label>
              <input
                style={{ width: 110 }}
                inputMode="decimal"
                value={slash}
                onChange={(e) => setSlash(e.target.value)}
              />
            </div>
          )}
          {slashOverStake && (
            <p className="hint" style={{ color: "var(--warn)" }}>
              Above the driver's {fmt(r.driverStake)} PAS stake — the contract caps the slash at the actual stake.
            </p>
          )}

          <div className="btn-row">
            <button
              className="btn danger"
              disabled={busy || !authorized}
              onClick={() =>
                run(
                  `Resolve #${r.id}`,
                  () => signed.disputes.resolve(r.id, bps, openerWins, driverAtFault, slashWei),
                  refresh
                )
              }
            >
              Issue ruling
            </button>
          </div>
          {!authorized && <p className="hint">Connect the arbiter wallet to enable rulings.</p>}
        </div>
      )}
    </div>
  );
}
