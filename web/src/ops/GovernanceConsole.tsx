import { useCallback, useEffect, useState } from "react";
import { contracts, fmt, parse, short, syncAddressesFromRouter, nodeLabel } from "../chain";
import { ConsoleProps, Run } from "./OpsApp";
import {
  toInt, pct, secsLabel, bpsValid,
  feeBpsValid, cancelBpsValid, windowValid,
  radiusValid, maxAgeValid, skewValid,
  FEE_BPS_MAX, CANCEL_BPS_MAX, WINDOW_MIN, WINDOW_MAX,
} from "./govparams";

// Governance params console (integration-plan D2).
//
// Every FARE contract carries owner-tunable knobs — protocol fee, driver
// stake floor, dispute bond, geofence radii — that were only reachable from
// deploy scripts. This is the operator surface: read each live value and, if
// the connected wallet owns that contract, retune it. Each domain is its own
// Ownable2Step, so authority is gated per-card, not globally.

// Unit helpers, bounds and field parsing live in ./govparams, which is
// differential-tested against the contracts in test/ops-governance.test.ts.

interface Gov {
  feeBps: number;
  assignedCancelBps: number;
  pickupWindow: number;
  deliveryWindow: number;
  relayRebateBps: number;
  minStake: bigint;
  unbondingSeconds: number;
  disputeBond: bigint;
  withdrawFeeBps: number;
  pickupRadius: number;
  dropoffRadius: number;
  maxAge: number;
  futureSkew: number;
}

type Domain = "orders" | "drivers" | "disputes" | "vault" | "settlement";

export default function GovernanceConsole({ session, busy, run, say }: ConsoleProps) {
  const [gov, setGov] = useState<Gov | null>(null);
  const [owners, setOwners] = useState<Record<Domain, string> | null>(null);
  const [loading, setLoading] = useState(false);

  const me = session?.address.toLowerCase() ?? null;
  const signed = session ? contracts(session.signer) : null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await syncAddressesFromRouter(); // follow router-driven upgrades
      const c = contracts();
      const [
        feeBps, assignedCancelBps, pickupWindow, deliveryWindow, relayRebateBps,
        minStake, unbondingSeconds,
        disputeBond,
        withdrawFeeBps,
        pickupRadius, dropoffRadius, maxAge, futureSkew,
        oOrders, oDrivers, oDisputes, oVault, oSettlement,
      ] = await Promise.all([
        c.orders.feeBps(), c.orders.assignedCancelBps(), c.orders.defaultPickupWindow(),
        c.orders.defaultDeliveryWindow(), c.orders.relayRebateBps(),
        c.drivers.minStake(), c.drivers.unbondingSeconds(),
        c.disputes.disputeBond(),
        c.vault.withdrawFeeBps(),
        c.settlement.pickupRadiusMeters(), c.settlement.dropoffRadiusMeters(),
        c.settlement.attestationMaxAgeSecs(), c.settlement.attestationFutureSkewSecs(),
        c.orders.owner(), c.drivers.owner(), c.disputes.owner(), c.vault.owner(), c.settlement.owner(),
      ]);
      setGov({
        feeBps: Number(feeBps),
        assignedCancelBps: Number(assignedCancelBps),
        pickupWindow: Number(pickupWindow),
        deliveryWindow: Number(deliveryWindow),
        relayRebateBps: Number(relayRebateBps),
        minStake,
        unbondingSeconds: Number(unbondingSeconds),
        disputeBond,
        withdrawFeeBps: Number(withdrawFeeBps),
        pickupRadius: Number(pickupRadius),
        dropoffRadius: Number(dropoffRadius),
        maxAge: Number(maxAge),
        futureSkew: Number(futureSkew),
      });
      setOwners({
        orders: String(oOrders).toLowerCase(),
        drivers: String(oDrivers).toLowerCase(),
        disputes: String(oDisputes).toLowerCase(),
        vault: String(oVault).toLowerCase(),
        settlement: String(oSettlement).toLowerCase(),
      });
    } catch (e: any) {
      say(`Load failed: ${e?.shortMessage ?? e?.message ?? e}`, true);
    } finally {
      setLoading(false);
    }
  }, [say]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const ownsAll = !!me && !!owners && (Object.keys(owners) as Domain[]).every((d) => owners[d] === me);
  const myDomains = me && owners ? (Object.keys(owners) as Domain[]).filter((d) => owners[d] === me) : [];
  const can = (d: Domain) => !!me && !!owners && owners[d] === me;

  const shared: Omit<CardProps, "authorized"> = { busy, run, signed, refresh };

  return (
    <>
      <div className="card">
        <h2>
          Owner authority
          <button className="btn small ghost" style={{ marginLeft: "auto" }} disabled={loading} onClick={refresh}>
            {loading ? "…" : "↻ refresh"}
          </button>
        </h2>
        <div className="kv"><span className="k">connected</span><span className="v mono">{me ? short(me) : "—"}</span></div>
        <div className="kv"><span className="k">controls</span><span className="v">{myDomains.length ? myDomains.join(", ") : session ? "none" : "—"}</span></div>
        <div className="kv"><span className="k">node</span><span className="v">{nodeLabel()}</span></div>
        {session && (
          <p className="hint" style={{ color: myDomains.length ? "var(--ok)" : "var(--err)" }}>
            {ownsAll
              ? "✓ Owner of every governance contract — all params writable."
              : myDomains.length
              ? "◑ Owner of some contracts — only those cards are writable."
              : "⚠ This wallet owns no governance contract. Every setter will revert."}
          </p>
        )}
        {!session && <p className="hint">Connect the owner wallet to retune parameters.</p>}
      </div>

      {!gov && <div className="card"><div className="empty">{loading ? "Reading on-chain params…" : "No params loaded."}</div></div>}

      {gov && (
        <>
          {/* ---- orders: economics + windows (setParams, atomic) ---- */}
          <OrderEconomicsCard key={`oe-${gov.feeBps}-${gov.assignedCancelBps}-${gov.pickupWindow}-${gov.deliveryWindow}`} g={gov} authorized={can("orders")} {...shared} />

          {/* ---- orders: relay rebate (separate tx) ---- */}
          <SingleBpsCard
            key={`rebate-${gov.relayRebateBps}`}
            title="Relay rebate"
            note="Share of the protocol fee rebated to the settling relay. Carved from treasury's cut — never adds cost to an order (F6)."
            label="relayRebateBps"
            cur={gov.relayRebateBps}
            max={10_000}
            authorized={can("orders")}
            send={(v) => shared.signed!.orders.setRelayRebateBps(v)}
            txLabel="Set relay rebate"
            {...shared}
          />

          {/* ---- driver stake floor + unbonding ---- */}
          <DriverStakeCard key={`ds-${gov.minStake}-${gov.unbondingSeconds}`} g={gov} authorized={can("drivers")} {...shared} />

          {/* ---- disputes: open bond ---- */}
          <SinglePasCard
            key={`bond-${gov.disputeBond}`}
            title="Dispute bond"
            note="Stake required to open a dispute. 0 during bootstrap; raise to deter griefing. Refunded to the winner, forfeited to treasury otherwise."
            label="disputeBond"
            cur={gov.disputeBond}
            authorized={can("disputes")}
            send={(v) => shared.signed!.disputes.setDisputeBond(v)}
            txLabel="Set dispute bond"
            {...shared}
          />

          {/* ---- vault: withdraw relay fee ---- */}
          <SingleBpsCard
            key={`wf-${gov.withdrawFeeBps}`}
            title="Withdrawal fee"
            note="Fee taken on a gasless (relayed) withdraw, paid to the submitting relay. Direct self-withdraws are unaffected."
            label="withdrawFeeBps"
            cur={gov.withdrawFeeBps}
            max={1_000}
            authorized={can("vault")}
            send={(v) => shared.signed!.vault.setWithdrawFeeBps(v)}
            txLabel="Set withdrawal fee"
            {...shared}
          />

          {/* ---- settlement: geofence + attestation freshness (setGeoParams, atomic) ---- */}
          <GeoParamsCard key={`geo-${gov.pickupRadius}-${gov.dropoffRadius}-${gov.maxAge}-${gov.futureSkew}`} g={gov} authorized={can("settlement")} {...shared} />
        </>
      )}
    </>
  );
}

// ---------- shared field + card scaffolding ----------

interface CardProps {
  busy: boolean;
  run: Run;
  signed: ReturnType<typeof contracts> | null;
  refresh: () => Promise<any>;
  authorized: boolean;
}

function Field({
  label,
  cur,
  draft,
  onDraft,
  hint,
  warn,
}: {
  label: string;
  cur: string;
  draft: string;
  onDraft: (v: string) => void;
  hint?: string;
  warn?: string;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div className="kv"><span className="k">{label}</span><span className="v mono">now {cur}</span></div>
      <input value={draft} onChange={(e) => onDraft(e.target.value)} inputMode="decimal" style={{ width: "100%" }} />
      {hint && <p className="hint" style={{ marginTop: 4 }}>{hint}</p>}
      {warn && <p className="hint" style={{ marginTop: 4, color: "var(--warn)" }}>{warn}</p>}
    </div>
  );
}

function SaveRow({ authorized, busy, disabled, onSave, label }: { authorized: boolean; busy: boolean; disabled: boolean; onSave: () => void; label: string }) {
  return (
    <>
      <div className="btn-row">
        <button className="btn" disabled={busy || !authorized || disabled} onClick={onSave}>{label}</button>
      </div>
      {!authorized && <p className="hint">Connect the owning wallet to enable this.</p>}
    </>
  );
}

// ---------- orders: setParams (fee, cancel comp, default windows) ----------

function OrderEconomicsCard({ g, authorized, busy, run, signed, refresh }: { g: Gov } & CardProps) {
  const [fee, setFee] = useState(String(g.feeBps));
  const [cancel, setCancel] = useState(String(g.assignedCancelBps));
  const [pickup, setPickup] = useState(String(g.pickupWindow));
  const [delivery, setDelivery] = useState(String(g.deliveryWindow));

  const fBps = toInt(fee), cBps = toInt(cancel), pW = toInt(pickup), dW = toInt(delivery);
  const feeErr = !feeBpsValid(fBps);
  const cancelErr = !cancelBpsValid(cBps);
  const pickupErr = !windowValid(pW);
  const deliveryErr = !windowValid(dW);
  const invalid = feeErr || cancelErr || pickupErr || deliveryErr;

  return (
    <div className="card">
      <h2>Order economics</h2>
      <p className="hint">Protocol fee, post-assignment cancel compensation, and default delivery deadlines. Applied atomically via setParams.</p>
      <Field label="feeBps — protocol fee on fare" cur={`${g.feeBps} (${pct(g.feeBps)})`} draft={fee} onDraft={setFee}
        hint={`bps, ≤ ${FEE_BPS_MAX} (10%). ${!feeErr ? `= ${pct(fBps)}` : ""}`} warn={feeErr ? "Must be an integer 0–1000." : undefined} />
      <Field label="assignedCancelBps — driver comp on cancel" cur={`${g.assignedCancelBps} (${pct(g.assignedCancelBps)})`} draft={cancel} onDraft={setCancel}
        hint={`bps of fare, ≤ ${CANCEL_BPS_MAX} (50%). ${!cancelErr ? `= ${pct(cBps)}` : ""}`} warn={cancelErr ? "Must be an integer 0–5000." : undefined} />
      <Field label="defaultPickupWindow — seconds" cur={`${g.pickupWindow} (${secsLabel(g.pickupWindow)})`} draft={pickup} onDraft={setPickup}
        hint={`seconds, ${WINDOW_MIN}–${WINDOW_MAX} (10m–24h). ${!pickupErr ? `= ${secsLabel(pW)}` : ""}`} warn={pickupErr ? "Out of range (600–86400)." : undefined} />
      <Field label="defaultDeliveryWindow — seconds" cur={`${g.deliveryWindow} (${secsLabel(g.deliveryWindow)})`} draft={delivery} onDraft={setDelivery}
        hint={`seconds, ${WINDOW_MIN}–${WINDOW_MAX} (10m–24h). ${!deliveryErr ? `= ${secsLabel(dW)}` : ""}`} warn={deliveryErr ? "Out of range (600–86400)." : undefined} />
      <SaveRow authorized={authorized} busy={busy} disabled={invalid}
        onSave={() => run("Set order params", () => signed!.orders.setParams(fBps, cBps, pW, dW), refresh)} label="Save order params" />
    </div>
  );
}

// ---------- drivers: minStake + unbondingSeconds (two independent setters) ----------

function DriverStakeCard({ g, authorized, busy, run, signed, refresh }: { g: Gov } & CardProps) {
  const [stake, setStake] = useState(fmt(g.minStake));
  const [unbond, setUnbond] = useState(String(g.unbondingSeconds));

  let stakeWei: bigint | null = null;
  try { stakeWei = parse(stake); } catch { stakeWei = null; }
  const uSecs = toInt(unbond);
  const unbondErr = !(Number.isInteger(uSecs) && uSecs >= 0);

  return (
    <div className="card">
      <h2>Driver stake</h2>
      <p className="hint">The stake floor a driver must post to be eligible, and the cooldown before staked funds can be withdrawn.</p>
      <Field label="minStake — PAS" cur={`${fmt(g.minStake)} PAS`} draft={stake} onDraft={setStake}
        hint="0 = registration alone qualifies." warn={stakeWei === null ? "Unparseable amount." : undefined} />
      <div className="btn-row">
        <button className="btn" disabled={busy || !authorized || stakeWei === null}
          onClick={() => run("Set min stake", () => signed!.drivers.setMinStake(stakeWei!), refresh)}>Save min stake</button>
      </div>
      <Field label="unbondingSeconds — seconds" cur={`${g.unbondingSeconds} (${secsLabel(g.unbondingSeconds)})`} draft={unbond} onDraft={setUnbond}
        hint={`Cooldown after requestUnstake. ${!unbondErr ? `= ${secsLabel(uSecs)}` : ""}`} warn={unbondErr ? "Must be a non-negative integer." : undefined} />
      <div className="btn-row">
        <button className="btn" disabled={busy || !authorized || unbondErr}
          onClick={() => run("Set unbonding", () => signed!.drivers.setUnbondingSeconds(uSecs), refresh)}>Save unbonding</button>
      </div>
      {!authorized && <p className="hint">Connect the owning wallet to enable this.</p>}
    </div>
  );
}

// ---------- settlement: setGeoParams ----------

function GeoParamsCard({ g, authorized, busy, run, signed, refresh }: { g: Gov } & CardProps) {
  const [pr, setPr] = useState(String(g.pickupRadius));
  const [dr, setDr] = useState(String(g.dropoffRadius));
  const [age, setAge] = useState(String(g.maxAge));
  const [skew, setSkew] = useState(String(g.futureSkew));

  const prN = toInt(pr), drN = toInt(dr), ageN = toInt(age), skewN = toInt(skew);
  const prErr = !radiusValid(prN), drErr = !radiusValid(drN);
  const ageErr = !maxAgeValid(ageN);
  const skewErr = !skewValid(skewN);
  const invalid = prErr || drErr || ageErr || skewErr;

  return (
    <div className="card">
      <h2>Geofencing</h2>
      <p className="hint">Pickup/dropoff proximity radii and how fresh a location attestation must be. Applied atomically via setGeoParams.</p>
      <Field label="pickupRadiusMeters" cur={`${g.pickupRadius} m`} draft={pr} onDraft={setPr}
        hint="meters, 25–2000." warn={prErr ? "Out of range (25–2000)." : undefined} />
      <Field label="dropoffRadiusMeters" cur={`${g.dropoffRadius} m`} draft={dr} onDraft={setDr}
        hint="meters, 25–2000." warn={drErr ? "Out of range (25–2000)." : undefined} />
      <Field label="attestationMaxAgeSecs — seconds" cur={`${g.maxAge} (${secsLabel(g.maxAge)})`} draft={age} onDraft={setAge}
        hint={`seconds, 60–7200 (1m–2h). ${!ageErr ? `= ${secsLabel(ageN)}` : ""}`} warn={ageErr ? "Out of range (60–7200)." : undefined} />
      <Field label="attestationFutureSkewSecs — seconds" cur={`${g.futureSkew} (${secsLabel(g.futureSkew)})`} draft={skew} onDraft={setSkew}
        hint={`seconds, ≤ 1800 (30m). ${!skewErr ? `= ${secsLabel(skewN)}` : ""}`} warn={skewErr ? "Out of range (0–1800)." : undefined} />
      <SaveRow authorized={authorized} busy={busy} disabled={invalid}
        onSave={() => run("Set geo params", () => signed!.settlement.setGeoParams(prN, drN, ageN, skewN), refresh)} label="Save geo params" />
    </div>
  );
}

// ---------- generic single-value cards (bps / PAS) ----------

function SingleBpsCard({
  title, note, label, cur, max, authorized, busy, run, refresh, send, txLabel,
}: {
  title: string; note: string; label: string; cur: number; max: number;
  send: (v: number) => Promise<any>; txLabel: string;
} & CardProps) {
  const [draft, setDraft] = useState(String(cur));
  const v = toInt(draft);
  const err = !bpsValid(v, max);
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="hint">{note}</p>
      <Field label={`${label} — bps`} cur={`${cur} (${pct(cur)})`} draft={draft} onDraft={setDraft}
        hint={`bps, ≤ ${max} (${pct(max)}). ${!err ? `= ${pct(v)}` : ""}`} warn={err ? `Must be an integer 0–${max}.` : undefined} />
      <SaveRow authorized={authorized} busy={busy} disabled={err} onSave={() => run(txLabel, () => send(v), refresh)} label={txLabel} />
    </div>
  );
}

function SinglePasCard({
  title, note, label, cur, authorized, busy, run, refresh, send, txLabel,
}: {
  title: string; note: string; label: string; cur: bigint;
  send: (v: bigint) => Promise<any>; txLabel: string;
} & CardProps) {
  const [draft, setDraft] = useState(fmt(cur));
  let wei: bigint | null = null;
  try { wei = parse(draft); } catch { wei = null; }
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="hint">{note}</p>
      <Field label={`${label} — PAS`} cur={`${fmt(cur)} PAS`} draft={draft} onDraft={setDraft}
        warn={wei === null ? "Unparseable amount." : undefined} />
      <SaveRow authorized={authorized} busy={busy} disabled={wei === null} onSave={() => run(txLabel, () => send(wei!), refresh)} label={txLabel} />
    </div>
  );
}
