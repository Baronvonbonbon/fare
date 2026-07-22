import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import {
  Session,
  SignerMode,
  connect,
  contracts,
  fmt,
  parse,
  short,
  syncAddressesFromRouter,
  nodeLabel,
} from "../chain";

// FARE — Arbiter console (integration-plan D1).
//
// The arbitrated escape hatch (FareDisputes) had no ruling UI at all — `resolve`
// was reachable only from a script. This is that console: connect as the
// on-chain `arbiter`, see the queue of open disputes with their order + driver
// context, and issue a ruling (escrow split, bond outcome, reputation strike,
// stake slash). It lives OUTSIDE the consumer PWA on purpose (group D, ⚙️).

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
  // joined driver context (null if no driver assigned)
  driverStake: bigint;
  driverDelivered: number;
  driverFailed: number;
}

export default function OpsApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [arbiter, setArbiter] = useState<string | null>(null);
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const say = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast(null), err ? 8000 : 4500);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await syncAddressesFromRouter(); // follow router-driven upgrades
      const c = contracts();
      setArbiter((await c.disputes.arbiter()).toLowerCase());

      const n = Number(await c.disputes.nextDisputeId());
      const ids = Array.from({ length: Math.max(0, n - 1) }, (_, i) => BigInt(i + 1));
      const raw = await Promise.all(ids.map((id) => c.disputes.disputes(id)));

      // Only real disputes (status None means an id gap — shouldn't happen, but
      // guard anyway). Join the order + driver context each ruling needs.
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

  /// Wrap a ruling tx with busy state + toast + reload.
  const act = useCallback(
    async (label: string, fn: () => Promise<any>) => {
      if (!session) return say("Connect the arbiter wallet first", true);
      setBusy(true);
      try {
        const tx = await fn();
        if (tx?.wait) await tx.wait();
        say(`${label} ✓`);
        await refresh();
      } catch (e: any) {
        say(`${label} failed: ${e?.reason ?? e?.shortMessage ?? e?.message ?? e}`, true);
      } finally {
        setBusy(false);
      }
    },
    [session, say, refresh]
  );

  const onConnect = useCallback(
    async (mode: SignerMode, key?: string) => {
      try {
        const s = await connect(mode, key);
        setSession(s);
        say(`Connected ${short(s.address)}`);
      } catch (e: any) {
        say(e?.message ?? String(e), true);
      }
    },
    [say]
  );

  const me = session?.address.toLowerCase() ?? null;
  const authorized = !!me && !!arbiter && me === arbiter;
  const signed = session ? contracts(session.signer) : null;

  const open = rows.filter((r) => r.status === 1);
  const resolved = rows.filter((r) => r.status === 2);

  return (
    <>
      <header className="masthead">
        <div className="logo">
          FARE<span className="dot" aria-hidden="true">.</span>
          <small>arbiter console · disputes</small>
        </div>
        <ConnectChip session={session} onConnect={onConnect} />
      </header>

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
        {!session && <p className="hint">Connect the arbiter wallet (injected or private key) to issue rulings.</p>}
      </div>

      <div className="card">
        <h2>
          Open disputes {open.length > 0 && <span className="tag">{open.length}</span>}
          <button
            className="btn small ghost"
            style={{ marginLeft: "auto" }}
            disabled={loading}
            onClick={refresh}
          >
            {loading ? "…" : "↻ refresh"}
          </button>
        </h2>
        {open.length === 0 && (
          <div className="empty">{loading ? "Loading the queue…" : "No open disputes."}</div>
        )}
        {open.map((r) => (
          <DisputeCard key={String(r.id)} r={r} authorized={authorized} busy={busy} act={act} signed={signed} />
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
              <DisputeCard key={String(r.id)} r={r} authorized={authorized} busy={busy} act={act} signed={signed} />
            ))}
        </div>
      )}

      {toast && <div className={`toast${toast.err ? " err" : ""}`}>{toast.msg}</div>}
    </>
  );
}

// ---------- dispute card + ruling form ----------

function DisputeCard({
  r,
  authorized,
  busy,
  act,
  signed,
}: {
  r: DisputeRow;
  authorized: boolean;
  busy: boolean;
  act: (label: string, fn: () => Promise<any>) => Promise<any>;
  signed: any;
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
                act(`Resolve #${r.id}`, () =>
                  signed.disputes.resolve(r.id, bps, openerWins, driverAtFault, slashWei)
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

// ---------- connect chip (injected wallet or pasted key) ----------

function ConnectChip({
  session,
  onConnect,
}: {
  session: Session | null;
  onConnect: (mode: SignerMode, key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [k, setK] = useState("");
  const box = useRef<HTMLDivElement>(null);

  if (session) {
    return (
      <button className="wallet-chip" title={session.address}>
        <span className="status-dot" /> {short(session.address)}
      </button>
    );
  }

  return (
    <div ref={box} style={{ position: "relative" }}>
      <button className="wallet-chip disconnected" onClick={() => setOpen((v) => !v)}>
        <span className="status-dot" /> connect arbiter
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: "110%", zIndex: 10, minWidth: 240 }}>
          <button className="btn small" style={{ width: "100%" }}
            onClick={() => { setOpen(false); onConnect("injected"); }}>
            Injected wallet
          </button>
          <div style={{ marginTop: 10 }}>
            <input placeholder="0x… arbiter private key" value={k} onChange={(e) => setK(e.target.value)} />
            <button className="btn small" style={{ width: "100%", marginTop: 8 }} disabled={!k}
              onClick={() => { setOpen(false); onConnect("key", k); }}>
              Use key
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
