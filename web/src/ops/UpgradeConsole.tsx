import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { ADDRESSES, readProvider, short, syncAddressesFromRouter, nodeLabel } from "../chain";
import { ROUTER_ABI, UPGRADABLE_ABI } from "../abi";
import { ConsoleProps, Run } from "./OpsApp";

// Upgrade console (integration-plan D4).
//
// The FareGovernanceRouter is the stable-address registry every client and
// contract resolves through, and the seat of upgrade authority — but its admin
// calls (upgradeContract / setContractFrozen / register) were script-only.
// This is that surface: read each registered contract's live address, version,
// freeze state and history, and drive a freeze-and-drain promotion.
//
// Upgrade posture (see FareUpgradable): promoting a v2 optionally freezes v1 —
// entry mutators (new orders/bids/registrations) blocked, every exit path
// (cancel, settle, withdraw, unstake, resolve) stays open. In-flight state
// drains; nothing is trapped. setContractFrozen is the manual rollback lever.

// Registered names, mirroring scripts/deploy.ts. pauseRegistry is registered
// for discovery only — it is not FareUpgradable, so it has no freeze state and
// can only be re-pointed via register(), never upgradeContract().
const NAMES: { name: string; upgradable: boolean }[] = [
  { name: "orders", upgradable: true },
  { name: "settlement", upgradable: true },
  { name: "disputes", upgradable: true },
  { name: "drivers", upgradable: true },
  { name: "venues", upgradable: true },
  { name: "vault", upgradable: true },
  { name: "ratings", upgradable: true },
  { name: "pauseRegistry", upgradable: false },
];

interface Row {
  name: string;
  upgradable: boolean;
  key: string; // bytes32
  addr: string;
  version: number;
  frozen: boolean;
  history: string[];
}

export default function UpgradeConsole({ session, busy, run, say }: ConsoleProps) {
  const [owner, setOwner] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  const me = session?.address.toLowerCase() ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await syncAddressesFromRouter();
      const router = new ethers.Contract(ADDRESSES.router, ROUTER_ABI, readProvider);
      setOwner(String(await router.owner()).toLowerCase());

      const built = await Promise.all(
        NAMES.map(async ({ name, upgradable }): Promise<Row> => {
          const key = ethers.encodeBytes32String(name);
          const [addr, version, history] = await Promise.all([
            router.currentAddrOf(key),
            router.versionOf(key),
            router.historyOf(key),
          ]);
          let frozen = false;
          if (upgradable && addr !== ethers.ZeroAddress) {
            try {
              frozen = await new ethers.Contract(addr, UPGRADABLE_ABI, readProvider).frozen();
            } catch {
              /* older deployment without the getter — leave false */
            }
          }
          return {
            name,
            upgradable,
            key,
            addr: String(addr).toLowerCase(),
            version: Number(version),
            frozen,
            history: (history as string[]).map((h) => h.toLowerCase()),
          };
        })
      );
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

  const authorized = !!me && !!owner && me === owner;
  const signedRouter = session ? new ethers.Contract(ADDRESSES.router, ROUTER_ABI, session.signer) : null;
  const frozenCount = rows.filter((r) => r.frozen).length;

  return (
    <>
      <div className="card">
        <h2>
          Router authority
          <button className="btn small ghost" style={{ marginLeft: "auto" }} disabled={loading} onClick={refresh}>
            {loading ? "…" : "↻ refresh"}
          </button>
        </h2>
        <div className="kv"><span className="k">router</span><span className="v mono">{ADDRESSES.router ? short(ADDRESSES.router) : "—"}</span></div>
        <div className="kv"><span className="k">on-chain owner</span><span className="v mono">{owner ? short(owner) : "…"}</span></div>
        <div className="kv"><span className="k">connected</span><span className="v mono">{me ? short(me) : "—"}</span></div>
        <div className="kv"><span className="k">node</span><span className="v">{nodeLabel()}</span></div>
        {session && (
          <p className="hint" style={{ color: authorized ? "var(--ok)" : "var(--err)" }}>
            {authorized
              ? "✓ Router owner — promotions and freezes will settle."
              : "⚠ This wallet is not the router owner. Every admin call will revert."}
          </p>
        )}
        {!session && <p className="hint">Connect the router owner wallet to promote or freeze contracts.</p>}
      </div>

      <div className="card">
        <h2>
          Registry {frozenCount > 0 && <span className="tag">{frozenCount} frozen</span>}
        </h2>
        {rows.length === 0 && <div className="empty">{loading ? "Reading the registry…" : "No contracts registered."}</div>}
        {rows.map((r) => (
          <RegistryRow key={r.name} r={r} authorized={authorized} busy={busy} run={run} signedRouter={signedRouter} refresh={refresh} />
        ))}
      </div>
    </>
  );
}

// ---------- one registry entry + its admin levers ----------

function RegistryRow({
  r,
  authorized,
  busy,
  run,
  signedRouter,
  refresh,
}: {
  r: Row;
  authorized: boolean;
  busy: boolean;
  run: Run;
  signedRouter: ethers.Contract | null;
  refresh: () => Promise<any>;
}) {
  const [newAddr, setNewAddr] = useState("");
  const [freezeOld, setFreezeOld] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  const valid = ethers.isAddress(newAddr);
  const sameAsCurrent = valid && newAddr.toLowerCase() === r.addr;
  const canSubmit = authorized && valid && !sameAsCurrent;

  return (
    <div className="order">
      <div className="order-head">
        <span className="order-id">{r.name}{!r.upgradable && " · discovery-only"}</span>
        <span className={`badge ${r.frozen ? "disputed" : "resolved"}`}>
          v{r.version}{r.frozen ? " · FROZEN" : ""}
        </span>
      </div>

      <div className="kv"><span className="k">address</span><span className="v mono">{r.addr === ethers.ZeroAddress ? "—" : short(r.addr)}</span></div>
      <div className="kv"><span className="k">version</span><span className="v">{r.version}</span></div>
      <div className="kv">
        <span className="k">history</span>
        <span className="v">
          {r.history.length === 0 ? "none" : (
            <button className="btn small ghost" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? "hide" : `${r.history.length} prior`}
            </button>
          )}
        </span>
      </div>
      {showHistory && r.history.map((h, i) => (
        <div className="kv" key={h + i}><span className="k">v{i + 1}</span><span className="v mono">{short(h)}</span></div>
      ))}

      {r.frozen && (
        <p className="hint" style={{ color: "var(--warn)" }}>
          Frozen — entry mutators blocked, every exit path (cancel, settle, withdraw, resolve) stays open.
        </p>
      )}

      <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
        <div className="section-note">{r.upgradable ? "Promote successor" : "Re-point (discovery)"}</div>

        <input
          style={{ width: "100%", marginTop: 8 }}
          placeholder="0x… new implementation address"
          value={newAddr}
          onChange={(e) => setNewAddr(e.target.value)}
        />
        {sameAsCurrent && <p className="hint" style={{ color: "var(--warn)" }}>That is already the current address.</p>}

        {r.upgradable ? (
          <>
            <label className="hint" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
              <input type="checkbox" checked={freezeOld} onChange={(e) => setFreezeOld(e.target.checked)} />
              Freeze v{r.version} on promotion — drains in-flight state, blocks new entries
            </label>
            <div className="btn-row">
              <button
                className="btn"
                disabled={busy || !canSubmit}
                onClick={() =>
                  run(
                    `Upgrade ${r.name} → v${r.version + 1}`,
                    () => signedRouter!.upgradeContract(r.key, newAddr, freezeOld),
                    async () => { setNewAddr(""); await refresh(); }
                  )
                }
              >
                Promote to v{r.version + 1}
              </button>
              <button
                className={`btn ${r.frozen ? "" : "danger"}`}
                disabled={busy || !authorized || r.addr === ethers.ZeroAddress}
                onClick={() =>
                  run(
                    `${r.frozen ? "Unfreeze" : "Freeze"} ${r.name}`,
                    () => signedRouter!.setContractFrozen(r.key, r.addr, !r.frozen),
                    refresh
                  )
                }
              >
                {r.frozen ? "Unfreeze current" : "Freeze current"}
              </button>
            </div>
          </>
        ) : (
          <div className="btn-row">
            <button
              className="btn"
              disabled={busy || !canSubmit}
              onClick={() =>
                run(
                  `Re-point ${r.name}`,
                  () => signedRouter!.register(r.key, newAddr),
                  async () => { setNewAddr(""); await refresh(); }
                )
              }
            >
              Re-point to new address
            </button>
          </div>
        )}
        {!authorized && <p className="hint">Connect the router owner wallet to enable these.</p>}
      </div>
    </div>
  );
}
