import { useCallback, useState } from "react";
import { Session, SignerMode, connect, short } from "../chain";
import DisputesConsole from "./DisputesConsole";
import GovernanceConsole from "./GovernanceConsole";
import PauseConsole from "./PauseConsole";
import UpgradeConsole from "./UpgradeConsole";

// FARE — ops / governance console (integration-plan group D).
//
// A SEPARATE app from the consumer PWA — same chain glue, no shared nav, no
// service worker. Deployed alongside the PWA at /ops. A thin shell that holds
// one shared wallet session + toast and routes between the per-domain consoles:
//
//   • Disputes (D1) — arbiter ruling queue
//   • Params   (D2) — owner-tunable governance knobs
//   • Pause    (D3) — guardian emergency stop
//   • Upgrade  (D4) — router registry + freeze-and-drain promotion

export type Run = (label: string, fn: () => Promise<any>, after?: () => Promise<any> | void) => Promise<void>;

export interface ConsoleProps {
  session: Session | null;
  busy: boolean;
  run: Run;
  say: (msg: string, err?: boolean) => void;
}

type Tab = "disputes" | "params" | "pause" | "upgrade";

const TABS: { id: Tab; glyph: string; label: string }[] = [
  { id: "disputes", glyph: "⚖️", label: "disputes" },
  { id: "params", glyph: "🎛", label: "params" },
  { id: "pause", glyph: "⏸", label: "pause" },
  { id: "upgrade", glyph: "⬆", label: "upgrade" },
];

export default function OpsApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [tab, setTab] = useState<Tab>("disputes");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  const say = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast(null), err ? 8000 : 4500);
  }, []);

  /// Shared tx wrapper: busy + toast + a console-supplied reload.
  const run = useCallback<Run>(
    async (label, fn, after) => {
      if (!session) return say("Connect a wallet first", true);
      setBusy(true);
      try {
        const tx = await fn();
        if (tx?.wait) await tx.wait();
        say(`${label} ✓`);
        await after?.();
      } catch (e: any) {
        say(`${label} failed: ${e?.reason ?? e?.shortMessage ?? e?.message ?? e}`, true);
      } finally {
        setBusy(false);
      }
    },
    [session, say]
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

  const props: ConsoleProps = { session, busy, run, say };

  return (
    <>
      <header className="masthead">
        <div className="logo">
          FARE<span className="dot" aria-hidden="true">.</span>
          <small>ops console · governance</small>
        </div>
        <ConnectChip session={session} onConnect={onConnect} />
      </header>

      <nav className="roles">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            <span className="glyph">{t.glyph}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "disputes" && <DisputesConsole {...props} />}
      {tab === "params" && <GovernanceConsole {...props} />}
      {tab === "pause" && <PauseConsole {...props} />}
      {tab === "upgrade" && <UpgradeConsole {...props} />}

      {toast && <div className={`toast${toast.err ? " err" : ""}`}>{toast.msg}</div>}
    </>
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

  if (session) {
    return (
      <button className="wallet-chip" title={session.address}>
        <span className="status-dot" /> {short(session.address)}
      </button>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button className="wallet-chip disconnected" onClick={() => setOpen((v) => !v)}>
        <span className="status-dot" /> connect
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: "110%", zIndex: 10, minWidth: 240 }}>
          <button className="btn small" style={{ width: "100%" }}
            onClick={() => { setOpen(false); onConnect("injected"); }}>
            Injected wallet
          </button>
          <div style={{ marginTop: 10 }}>
            <input placeholder="0x… private key" value={k} onChange={(e) => setK(e.target.value)} />
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
