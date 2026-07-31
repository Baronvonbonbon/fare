// Probe UI. Deliberately dependency-free and thumb-sized: this gets read on a
// phone, in a hurry, possibly outdoors.

import { CHECKS, type Check, type Ctx, type Outcome } from "./checks";
import "./style.css";

const ctx: Ctx = {};
const results = new Map<string, Outcome>();

const app = document.getElementById("app")!;
const summary = document.createElement("div");
summary.className = "summary";
app.appendChild(summary);

const list = document.createElement("div");
list.className = "checks";
app.appendChild(list);

function renderSummary() {
  const done = [...results.values()];
  const pass = done.filter((r) => r.status === "pass").length;
  const fail = done.filter((r) => r.status === "fail").length;
  const skip = done.filter((r) => r.status === "skip").length;
  summary.innerHTML =
    done.length === 0
      ? `<b>kite</b><span class="muted">${CHECKS.length} checks — tap Run all, or run them one at a time.</span>`
      : `<b>${pass}/${CHECKS.length} passed</b><span class="muted">${fail} failed · ${skip} skipped</span>`;
}

function card(check: Check) {
  const el = document.createElement("section");
  el.className = "check";
  el.innerHTML = `
    <header>
      <span class="dot pending" data-dot></span>
      <h2>${check.title}</h2>
      <button data-run>${check.manual ? "Capture" : "Run"}</button>
    </header>
    <p class="why">${check.why}</p>
    <p class="detail" data-detail></p>
    <pre data-data hidden></pre>
    <div data-extra></div>`;

  const dot = el.querySelector<HTMLElement>("[data-dot]")!;
  const btn = el.querySelector<HTMLButtonElement>("[data-run]")!;
  const detail = el.querySelector<HTMLElement>("[data-detail]")!;
  const data = el.querySelector<HTMLPreElement>("[data-data]")!;
  const extra = el.querySelector<HTMLElement>("[data-extra]")!;

  async function run() {
    btn.disabled = true;
    dot.className = "dot running";
    detail.textContent = "running…";
    data.hidden = true;
    let out: Outcome;
    try {
      out = await check.run(ctx);
    } catch (e) {
      out = { status: "fail", detail: `threw: ${(e as Error).message}` };
    }
    results.set(check.id, out);
    dot.className = `dot ${out.status}`;
    detail.textContent = out.detail;
    if (out.data) {
      data.textContent = out.data;
      data.hidden = false;
    }
    // The recovered photo is the single most convincing artifact — show it.
    if (check.id === "bulletin-down" && ctx.recoveredUrl) {
      extra.innerHTML = `<img src="${ctx.recoveredUrl}" alt="photo recovered from Bulletin"><span class="muted">↑ captured on this device, sealed, stored on Bulletin, fetched back, decrypted.</span>`;
    }
    btn.disabled = false;
    renderSummary();
  }

  btn.addEventListener("click", run);
  return { el, run, check };
}

const cards = CHECKS.map(card);
cards.forEach((c) => list.appendChild(c.el));

const runAll = document.createElement("button");
runAll.className = "runall";
runAll.textContent = "Run all";
runAll.addEventListener("click", async () => {
  runAll.disabled = true;
  for (const c of cards) {
    // Manual checks need a user gesture; a loop-driven click loses it on iOS.
    if (c.check.manual) continue;
    await c.run();
  }
  runAll.disabled = false;
  runAll.textContent = "Run all (re-run)";
});
app.insertBefore(runAll, list);

const copy = document.createElement("button");
copy.className = "copy";
copy.textContent = "Copy report";
copy.addEventListener("click", async () => {
  const lines = [
    `kite — ${new Date().toISOString()}`,
    navigator.userAgent,
    "",
    ...CHECKS.map((c) => {
      const r = results.get(c.id);
      if (!r) return `[ ] ${c.title} — not run`;
      const mark = r.status === "pass" ? "x" : r.status === "fail" ? "!" : "-";
      return `[${mark}] ${c.title} — ${r.detail}${r.data ? `\n${r.data.replace(/^/gm, "      ")}` : ""}`;
    }),
  ].join("\n");
  try {
    await navigator.clipboard.writeText(lines);
    copy.textContent = "Copied ✓";
  } catch {
    // Clipboard is often blocked in embedded runtimes — fall back to visible text.
    const pre = document.createElement("pre");
    pre.className = "report";
    pre.textContent = lines;
    app.appendChild(pre);
    copy.textContent = "Shown below";
  }
  setTimeout(() => (copy.textContent = "Copy report"), 2500);
});
app.appendChild(copy);

renderSummary();
