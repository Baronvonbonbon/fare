// Off-chain venue catalog. Menu content (items, prices, descriptions) lives in an
// IPFS JSON that the venue's on-chain `metadataURI` points at (`ipfs://<cid>`);
// `orderValue` is computed from the customer's cart client-side, so no cart
// contents or prices touch the ledger. Publishing goes through /api/menu (which
// holds the IPFS proxy key server-side); reads hit a public gateway directly.
//
// Graceful degradation: if IPFS isn't configured, publishMenu stores the menu in
// device-local storage and returns a `local://` URI so the demo still works on a
// single device (menus just aren't shared cross-device until IPFS is wired).
import { parseEther } from "ethers";

export interface MenuItem {
  id: string;
  name: string;
  price: string; // PAS, decimal string (e.g. "0.5")
  desc?: string;
  category?: string;
  available?: boolean; // default true
}

export interface Menu {
  name: string;
  items: MenuItem[];
  hours?: string;
  version: number;
  updatedAt: number;
}

export type Cart = Record<string, number>; // itemId -> qty

const GATEWAYS: string[] = [
  (import.meta as any).env?.VITE_IPFS_GATEWAY, // configured (e.g. DATUM) gateway, trailing /ipfs/
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
].filter(Boolean);

const cacheKey = (uri: string) => `fare.menu.${uri}`;

export function emptyMenu(name = ""): Menu {
  return { name, items: [], version: 1, updatedAt: Date.now() };
}

export function newItemId(): string {
  return Math.random().toString(36).slice(2, 9);
}

/// Does a venue metadataURI point at a resolvable menu (vs. a legacy demo:// name)?
export function hasMenuURI(uri?: string): boolean {
  return !!uri && (uri.startsWith("ipfs://") || uri.startsWith("local://"));
}

/// Publish a menu; returns the metadataURI to store on-chain via setMetadata.
/// `shared` is false when it fell back to device-local storage.
export async function publishMenu(menu: Menu): Promise<{ uri: string; shared: boolean }> {
  const payload: Menu = { ...menu, updatedAt: Date.now() };
  try {
    const res = await fetch("/api/menu", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const { cid } = (await res.json()) as { cid?: string };
      if (cid) {
        const uri = `ipfs://${cid}`;
        localStorage.setItem(cacheKey(uri), JSON.stringify(payload)); // warm the read cache
        return { uri, shared: true };
      }
    }
  } catch {
    /* fall through to local */
  }
  const uri = `local://${newItemId()}`;
  localStorage.setItem(cacheKey(uri), JSON.stringify(payload));
  return { uri, shared: false };
}

/// Fetch a menu from a venue metadataURI. Returns null for legacy/non-menu URIs
/// (demo://…) so callers fall back to manual price entry. Caches on success and
/// falls back to the cache when a gateway is unreachable.
export async function fetchMenu(uri?: string): Promise<Menu | null> {
  if (!hasMenuURI(uri)) return null;
  const cached = localStorage.getItem(cacheKey(uri!));
  if (uri!.startsWith("local://")) return cached ? (JSON.parse(cached) as Menu) : null;

  const cid = uri!.slice("ipfs://".length);
  for (const gw of GATEWAYS) {
    try {
      const res = await fetch(`${gw}${cid}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const m = (await res.json()) as Menu;
        localStorage.setItem(cacheKey(uri!), JSON.stringify(m));
        return m;
      }
    } catch {
      /* try next gateway */
    }
  }
  return cached ? (JSON.parse(cached) as Menu) : null; // offline → last-known
}

/// orderValue (wei) for a cart against a menu.
export function cartTotal(menu: Menu | null, cart: Cart): bigint {
  if (!menu) return 0n;
  let total = 0n;
  for (const item of menu.items) {
    const qty = cart[item.id] ?? 0;
    if (qty > 0) {
      try {
        total += parseEther(item.price || "0") * BigInt(qty);
      } catch {
        /* skip malformed price */
      }
    }
  }
  return total;
}

export function cartCount(cart: Cart): number {
  return Object.values(cart).reduce((n, q) => n + q, 0);
}
