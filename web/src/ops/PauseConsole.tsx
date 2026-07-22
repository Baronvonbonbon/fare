import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { contracts, short, syncAddressesFromRouter, nodeLabel } from "../chain";
import { ConsoleProps } from "./OpsApp";

// Guardian pause console (integration-plan D3).
//
// FarePauseRegistry is the per-category emergency stop shared by every FARE
// contract, but it had no operator surface — pause/unpause were script-only.
// This is that surface: see each category's live state and, if the connected
// wallet is a guardian or the owner, hit the brakes. Unpause and guardian-set
// changes are owner-only (guardians can stop the bleeding but not resume).

// Category enum mirrors FarePauseRegistry (0 orders … 3 registry).
const CATEGORIES: { id: number; label: string; blurb: string }[] = [
  { id: 0, label: "orders", blurb: "New orders + the order lifecycle (accept, pickup, deliver, cancel)." },
  { id: 1, label: "settlement", blurb: "Escrow release and driver / venue payouts." },
  { id: 2, label: "disputes", blurb: "Opening disputes and arbiter rulings." },
  { id: 3, label: "registry", blurb: "Router-driven address upgrades." },
];

export default function PauseConsole({ session, busy, run, say }: ConsoleProps) {
  const [owner, setOwner] = useState<string | null>(null);
  const [guardian, setGuardian] = useState(false); // is connected wallet a guardian
  const [paused, setPaused] = useState<boolean[]>([false, false, false, false]);
  const [loading, setLoading] = useState(false);
  const [newGuardian, setNewGuardian] = useState("");

  const me = session?.address.toLowerCase() ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await syncAddressesFromRouter(); // follow router-driven upgrades
      const c = contracts();
      const [own, ...states] = await Promise.all([
        c.pauseRegistry.owner(),
        ...CATEGORIES.map((cat) => c.pauseRegistry.paused(cat.id)),
      ]);
      setOwner(String(own).toLowerCase());
      setPaused(states.map(Boolean));
      setGuardian(me ? await c.pauseRegistry.isGuardian(me) : false);
    } catch (e: any) {
      say(`Load failed: ${e?.shortMessage ?? e?.message ?? e}`, true);
    } finally {
      setLoading(false);
    }
  }, [me, say]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const isOwner = !!me && !!owner && me === owner;
  const canPause = isOwner || guardian;
  const signed = session ? contracts(session.signer) : null;

  const anyPaused = paused.some(Boolean);

  return (
    <>
      <div className="card">
        <h2>Pause authority</h2>
        <div className="kv"><span className="k">on-chain owner</span><span className="v mono">{owner ? short(owner) : "…"}</span></div>
        <div className="kv"><span className="k">connected</span><span className="v mono">{me ? short(me) : "—"}</span></div>
        <div className="kv"><span className="k">role</span><span className="v">{isOwner ? "owner" : guardian ? "guardian" : session ? "none" : "—"}</span></div>
        <div className="kv"><span className="k">node</span><span className="v">{nodeLabel()}</span></div>
        {session && (
          <p className="hint" style={{ color: canPause ? "var(--ok)" : "var(--err)" }}>
            {isOwner
              ? "✓ Owner — can pause, unpause, and manage guardians."
              : guardian
              ? "✓ Guardian — can pause any category. Unpause is owner-only."
              : "⚠ This wallet is neither owner nor guardian. pause() will revert on-chain."}
          </p>
        )}
        {!session && <p className="hint">Connect a guardian or owner wallet to operate the brakes.</p>}
      </div>

      <div className="card">
        <h2>
          Categories {anyPaused && <span className="tag">{paused.filter(Boolean).length} paused</span>}
          <button className="btn small ghost" style={{ marginLeft: "auto" }} disabled={loading} onClick={refresh}>
            {loading ? "…" : "↻ refresh"}
          </button>
        </h2>
        {CATEGORIES.map((cat) => {
          const on = paused[cat.id];
          return (
            <div className="order" key={cat.id}>
              <div className="order-head">
                <span className="order-id">{cat.id} · {cat.label}</span>
                <span className={`badge ${on ? "disputed" : "resolved"}`}>{on ? "PAUSED" : "live"}</span>
              </div>
              <p className="hint" style={{ marginTop: 4 }}>{cat.blurb}</p>
              <div className="btn-row">
                {on ? (
                  <button
                    className="btn"
                    disabled={busy || !isOwner}
                    title={isOwner ? "" : "Unpause is owner-only"}
                    onClick={() =>
                      run(`Unpause ${cat.label}`, () => signed!.pauseRegistry.unpause(cat.id), refresh)
                    }
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    className="btn danger"
                    disabled={busy || !canPause}
                    onClick={() =>
                      run(`Pause ${cat.label}`, () => signed!.pauseRegistry.pause(cat.id), refresh)
                    }
                  >
                    Pause
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {session && !canPause && <p className="hint">Connect a guardian or owner wallet to enable the controls.</p>}
      </div>

      {isOwner && (
        <div className="card">
          <h2>Guardians</h2>
          <p className="hint">
            Owner-only. Guardians can fast-pause any category but cannot unpause — the fast-brake / slow-release split.
          </p>
          <div className="row" style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              style={{ flex: 1 }}
              placeholder="0x… guardian address"
              value={newGuardian}
              onChange={(e) => setNewGuardian(e.target.value)}
            />
          </div>
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !ethers.isAddress(newGuardian)}
              onClick={() =>
                run(
                  `Add guardian ${short(newGuardian)}`,
                  () => signed!.pauseRegistry.setGuardian(newGuardian, true),
                  async () => { setNewGuardian(""); await refresh(); }
                )
              }
            >
              Add guardian
            </button>
            <button
              className="btn danger"
              disabled={busy || !ethers.isAddress(newGuardian)}
              onClick={() =>
                run(
                  `Remove guardian ${short(newGuardian)}`,
                  () => signed!.pauseRegistry.setGuardian(newGuardian, false),
                  async () => { setNewGuardian(""); await refresh(); }
                )
              }
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </>
  );
}
