import { describe, it, expect, beforeEach, vi } from "vitest";
import { Wallet } from "ethers";
import { topicOf, OrderThread } from "./channel";

// The relay channel (B3) end-to-end over an in-memory mock of /api/msg — proves
// the pubkey handshake, peer authentication, and E2E round-trip without a server.
// (msg.ts crypto + pool.ts are already covered by their own suites.)

// A tiny in-memory stand-in for the KV relay, wired into global.fetch.
const store = new Map<string, any[]>();
function mockRelay() {
  (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    const u = new URL(url, "http://localhost");
    if (init?.method === "POST") {
      const { topic, msg } = JSON.parse(init.body);
      const thread = store.get(topic) ?? [];
      const i = thread.findIndex((m) => m.from === msg.from && m.seq === msg.seq && m.kind === msg.kind);
      if (i >= 0) thread[i] = msg; else thread.push(msg);
      thread.sort((a, b) => a.ts - b.ts);
      store.set(topic, thread);
      return { ok: true, json: async () => ({ ok: true }) } as any;
    }
    const topic = u.searchParams.get("topic")!;
    const since = Number(u.searchParams.get("since") ?? 0);
    return { ok: true, json: async () => ({ messages: (store.get(topic) ?? []).filter((m) => m.ts > since) }) } as any;
  });
}

describe("relay channel (B3)", () => {
  beforeEach(() => { store.clear(); mockRelay(); });

  it("topicOf is deterministic, per-order, and a 32-byte hash", () => {
    expect(topicOf(7n)).toEqual(topicOf("7"));
    expect(topicOf(7n)).not.toEqual(topicOf(8n));
    expect(topicOf(7n)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("handshake + E2E round-trip between the order's two participants", async () => {
    const cust = Wallet.createRandom();
    const drv = Wallet.createRandom();
    const orderId = 42n;
    const custThread = new OrderThread(orderId, cust.privateKey, cust.address, drv.address);
    const drvThread = new OrderThread(orderId, drv.privateKey, drv.address, cust.address);

    // both announce; each learns + authenticates the other's pubkey
    await custThread.open();
    await drvThread.open();
    await custThread.poll();
    await drvThread.poll();
    expect(custThread.ready).toBe(true);
    expect(drvThread.ready).toBe(true);

    // driver sends; customer receives the decrypted text
    const sent = await drvThread.send("5 min away 🛵");
    expect(sent.mine).toBe(true);
    const got = await custThread.poll();
    expect(got.map((m) => m.text)).toEqual(["5 min away 🛵"]);
    expect(got[0].mine).toBe(false);
    expect(got[0].from.toLowerCase()).toBe(drv.address.toLowerCase());

    // reply back the other way
    await custThread.send("cool, buzzer #4");
    expect((await drvThread.poll()).map((m) => m.text)).toEqual(["cool, buzzer #4"]);
  });

  it("rejects an impersonator: a hello whose pubkey ≠ the expected peer is ignored", async () => {
    const cust = Wallet.createRandom();
    const drv = Wallet.createRandom();
    const imposter = Wallet.createRandom();
    const orderId = 99n;
    const custThread = new OrderThread(orderId, cust.privateKey, cust.address, drv.address);

    // imposter announces on the same topic pretending to be a participant
    const impThread = new OrderThread(orderId, imposter.privateKey, imposter.address, cust.address);
    await impThread.open();
    await custThread.poll();
    // customer must NOT have adopted the imposter's key (address mismatch)
    expect(custThread.ready).toBe(false);

    // the real driver announces → now it's ready
    const drvThread = new OrderThread(orderId, drv.privateKey, drv.address, cust.address);
    await drvThread.open();
    await custThread.poll();
    expect(custThread.ready).toBe(true);
  });

  it("driver location (B2) is delivered E2E to the customer via onLoc", async () => {
    const cust = Wallet.createRandom();
    const drv = Wallet.createRandom();
    const orderId = 7n;
    const locs: any[] = [];
    const custThread = new OrderThread(orderId, cust.privateKey, cust.address, drv.address, (l) => locs.push(l));
    const drvThread = new OrderThread(orderId, drv.privateKey, drv.address, cust.address);

    await custThread.open();
    await drvThread.open();
    await drvThread.poll(); // driver learns the customer's key

    expect(await drvThread.sendLoc(37_774_900, -122_419_400)).toBe(true);
    await custThread.poll();
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ lat: 37_774_900, lon: -122_419_400 });

    // a newer position supersedes; an unchanged (older) one doesn't re-fire
    await drvThread.sendLoc(37_775_500, -122_419_000);
    await custThread.poll();
    expect(locs).toHaveLength(2);
    expect(locs[1]).toMatchObject({ lat: 37_775_500 });
    await custThread.poll(); // no new loc → no extra callback
    expect(locs).toHaveLength(2);
  });

  it("proof-of-delivery photo pointer (B6) is delivered E2E via onPhoto", async () => {
    const cust = Wallet.createRandom();
    const drv = Wallet.createRandom();
    const orderId = 11n;
    const photos: any[] = [];
    const custThread = new OrderThread(orderId, cust.privateKey, cust.address, drv.address, undefined, (p) => photos.push(p));
    const drvThread = new OrderThread(orderId, drv.privateKey, drv.address, cust.address);

    await custThread.open();
    await drvThread.open();
    await drvThread.poll(); // driver learns the customer's key

    const key = "0x" + "ab".repeat(32);
    const id = "0x" + "cd".repeat(32);
    expect(await drvThread.sendPhoto(key, id)).toBe(true);
    await custThread.poll();
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ key, id });
    // idempotent: a re-poll of the same photo doesn't re-fire
    await custThread.poll();
    expect(photos).toHaveLength(1);
  });

  it("send() before the peer has joined throws a friendly wait", async () => {
    const a = Wallet.createRandom();
    const b = Wallet.createRandom();
    const t = new OrderThread(1n, a.privateKey, a.address, b.address);
    await expect(t.send("hi")).rejects.toThrow(/waiting/);
  });
});
