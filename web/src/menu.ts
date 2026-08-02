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
import { learnFromManifest, gatewayPool, type WithServices } from "./pool";

/// One selectable option within a group ("large", "extra cheese"). `priceDelta`
/// is added to the item's base price and may be "0".
export interface ModifierChoice {
  id: string;
  name: string;
  priceDelta: string; // PAS, decimal string
}

/// A set of choices offered on an item. `min`/`max` bound how many may be
/// picked; `required` is the common case of min ≥ 1 stated plainly.
export interface ModifierGroup {
  id: string;
  name: string;
  required?: boolean;
  min?: number;
  max?: number;
  choices: ModifierChoice[];
}

export interface MenuItem {
  id: string;
  name: string;
  price: string; // PAS, decimal string (e.g. "0.5")
  desc?: string;
  category?: string; // MenuCategory.id
  available?: boolean; // default true
  /// IPFS CID of the item photo. A CID, not a data URI: the menu JSON is capped
  /// at 64 KB by /api/menu, and images inline would blow that on the third dish.
  /// It also means `venue-node/agent.mjs` pins the photos with the menu (F3).
  image?: string;
  options?: ModifierGroup[];
}

export interface MenuCategory {
  id: string;
  name: string;
  order: number;
}

/// Opening hours for one weekday, 24h "HH:MM". `null` is closed. A close earlier
/// than the open means the venue trades past midnight.
export interface DayHours {
  open: string;
  close: string;
}

/// Sunday-first, seven entries — the same indexing as `Date.getDay()`, so no
/// off-by-one is possible at the call site.
export type WeekHours = (DayHours | null)[];

export const MENU_VERSION = 2;

export interface Menu extends WithServices {
  name: string;
  items: MenuItem[];
  /// v1 free-text hours. Kept because menus published before v2 carry it and a
  /// live venue's menu must not break under a client deploy; `schedule` wins
  /// when both are present.
  hours?: string;
  version: number;
  updatedAt: number;
  /// The venue hot signer's PUBLIC key, so a customer can seal the order ticket
  /// to it (ticket.ts). Publishing it here is safe — it's a public key, and the
  /// registry already publishes the matching address. It is a claim, not an
  /// authority: `verifiedVenueKey` uses it only once it derives to the signer
  /// `FareVenues` names, so a menu carrying someone else's key is inert.
  signerPub?: string;
  /// `fare-meta:v1:<hash>` over the venue's PRIVATE operational details (counter
  /// phone, where the driver actually collects) — revealed to the assigned driver
  /// over the order thread, never published. It lives here because the menu is
  /// the only document `metadataURI` anchors, and only the operator can
  /// `setMetadata`, so the chain still says which commitment counts.
  profileCommit?: string;
  // ── v2 ──
  categories?: MenuCategory[];
  schedule?: WeekHours;
  cuisine?: string[];
  logo?: string; // IPFS CID
  banner?: string; // IPFS CID
  // `services` (ipfsGateway / rpcUrl) is inherited from WithServices — a venue
  // may advertise its region's endpoints here, which we fold into the pool (F4).
}

/// One configured line in the cart. Two lines of the same item with different
/// options are genuinely different things to cook, so the cart is a LIST of
/// configurations rather than a qty per item id.
export interface CartLine {
  itemId: string;
  qty: number;
  choices: string[]; // ModifierChoice ids, across all of the item's groups
}

export type Cart = CartLine[];

/// Gateways to try, in order: the configured (e.g. DATUM) gateway, then venue/
/// region gateways discovered from manifests (F4 pool), then public fallbacks.
/// Deduped so a discovered gateway that equals the configured one isn't retried.
function gateways(): string[] {
  const ordered = [
    (import.meta as any).env?.VITE_IPFS_GATEWAY, // configured, trailing /ipfs/
    ...gatewayPool(), // discovered from manifests (region appliances, venues)
    "https://ipfs.io/ipfs/",
    "https://dweb.link/ipfs/",
  ].filter(Boolean) as string[];
  return [...new Set(ordered)];
}

const cacheKey = (uri: string) => `fare.menu.${uri}`;

export function emptyMenu(name = ""): Menu {
  return { name, items: [], categories: [], version: MENU_VERSION, updatedAt: Date.now() };
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

// ── images ───────────────────────────────────────────────────────────────────

/// A displayable URL for a menu image CID, using the same gateway order menus
/// are read through. Returns "" for a missing CID so callers can test it.
export function imageUrl(cid?: string): string {
  if (!cid) return "";
  if (/^(https?:|data:|blob:)/.test(cid)) return cid; // already a URL
  const bare = cid.startsWith("ipfs://") ? cid.slice("ipfs://".length) : cid;
  return `${gateways()[0]}${bare}`;
}

/// Upload menu artwork (item photo, logo, banner) and return its CID.
///
/// Separate from `publishMenu` on purpose: /api/menu caps the JSON at 64 KB, so
/// images have to be their own content-addressed objects rather than inlined.
/// Because the CID then lives inside the menu JSON, `venue-node/agent.mjs`
/// replicates the artwork along with the menu it pins (F3).
///
/// Throws when IPFS isn't configured — unlike a menu, an image has no useful
/// device-local fallback: a `local://` photo would render for the venue that
/// uploaded it and be a broken box for every customer.
export async function publishImage(bytes: Blob): Promise<string> {
  const res = await fetch("/api/asset", {
    method: "POST",
    headers: { "content-type": bytes.type || "application/octet-stream" },
    body: bytes,
  });
  const j = (await res.json().catch(() => ({}))) as { cid?: string; error?: string };
  if (!res.ok || !j.cid) {
    throw new Error(j.error ?? "image upload failed — IPFS is not configured for this deployment");
  }
  return j.cid;
}

/// Fetch a menu from a venue metadataURI. Returns null for legacy/non-menu URIs
/// (demo://…) so callers fall back to manual price entry. Caches on success and
/// falls back to the cache when a gateway is unreachable.
export async function fetchMenu(uri?: string): Promise<Menu | null> {
  if (!hasMenuURI(uri)) return null;
  const cached = localStorage.getItem(cacheKey(uri!));
  if (uri!.startsWith("local://")) return cached ? (JSON.parse(cached) as Menu) : null;

  const cid = uri!.slice("ipfs://".length);
  for (const gw of gateways()) {
    try {
      const res = await fetch(`${gw}${cid}`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const m = (await res.json()) as Menu;
        localStorage.setItem(cacheKey(uri!), JSON.stringify(m));
        learnFromManifest(m); // grow the pool from any services this menu advertises
        return m;
      }
    } catch {
      /* try next gateway */
    }
  }
  return cached ? (JSON.parse(cached) as Menu) : null; // offline → last-known
}

// ── reading a v1 menu ───────────────────────────────────────────────────────

/// Categories to render, in order. A v1 menu has none, and items may still carry
/// free-text `category` strings, so those are synthesized — otherwise upgrading
/// the client would flatten an existing venue's menu into one undifferentiated
/// list.
export function menuCategories(menu: Menu): MenuCategory[] {
  if (menu.categories?.length) return [...menu.categories].sort((a, b) => a.order - b.order);
  const seen = new Map<string, MenuCategory>();
  for (const it of menu.items) {
    const name = it.category?.trim();
    if (name && !seen.has(name)) seen.set(name, { id: name, name, order: seen.size });
  }
  return [...seen.values()];
}

/// The items in a category, or the uncategorized ones when `categoryId` is null.
export function itemsInCategory(menu: Menu, categoryId: string | null): MenuItem[] {
  const known = new Set(menuCategories(menu).map((c) => c.id));
  return menu.items.filter((it) => {
    const c = it.category?.trim();
    return categoryId === null ? !c || !known.has(c) : c === categoryId;
  });
}

// ── opening hours ────────────────────────────────────────────────────────────

const minutesOf = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm?.trim() ?? "");
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
};

/// Is the venue open at `at`? Unknown hours read as OPEN: a venue that never
/// filled in a schedule should not look permanently closed, which would hide it
/// from every customer for a field nobody was asked to complete.
export function isOpenAt(menu: Menu, at: Date = new Date()): boolean {
  const week = menu.schedule;
  if (!week || week.length !== 7) return true;
  const today = week[at.getDay()];
  const now = at.getHours() * 60 + at.getMinutes();

  // A window that closes before it opens runs past midnight, so the tail of it
  // belongs to YESTERDAY's entry — check that too or a 18:00–02:00 kitchen reads
  // as closed at 01:00.
  const yesterday = week[(at.getDay() + 6) % 7];
  if (yesterday) {
    const o = minutesOf(yesterday.open), c = minutesOf(yesterday.close);
    if (o !== null && c !== null && c < o && now < c) return true;
  }
  if (!today) return false;
  const open = minutesOf(today.open), close = minutesOf(today.close);
  if (open === null || close === null) return true; // malformed → don't hide the venue
  return close < open ? now >= open : now >= open && now < close;
}

// ── the cart ─────────────────────────────────────────────────────────────────

/// Identity of a configuration: same item, same options (order-insensitive) =
/// the same line, so pressing + twice makes 2× one dish, not two lines of 1.
export const lineKey = (itemId: string, choices: string[]): string =>
  `${itemId}|${[...choices].sort().join(",")}`;

export function findLine(cart: Cart, itemId: string, choices: string[]): number {
  const k = lineKey(itemId, choices);
  return cart.findIndex((l) => lineKey(l.itemId, l.choices) === k);
}

/// Add `qty` of a configuration, merging into an existing identical line.
export function addToCart(cart: Cart, itemId: string, choices: string[] = [], qty = 1): Cart {
  const i = findLine(cart, itemId, choices);
  if (i < 0) return qty > 0 ? [...cart, { itemId, qty, choices }] : cart;
  const next = cart.map((l, j) => (j === i ? { ...l, qty: l.qty + qty } : l));
  return next.filter((l) => l.qty > 0);
}

export function setLineQty(cart: Cart, index: number, qty: number): Cart {
  return cart.map((l, i) => (i === index ? { ...l, qty } : l)).filter((l) => l.qty > 0);
}

/// A cart line resolved against the menu — the shape the kitchen ticket and the
/// receipt both need, so neither has to re-derive prices.
export interface ResolvedLine {
  name: string;
  price: string;
  qty: number;
  choices: { name: string; priceDelta: string }[];
}

export function resolveLine(menu: Menu, line: CartLine): ResolvedLine | null {
  const item = menu.items.find((i) => i.id === line.itemId);
  if (!item) return null; // the menu changed under the cart
  const chosen = new Set(line.choices);
  const choices = (item.options ?? [])
    .flatMap((g) => g.choices)
    .filter((c) => chosen.has(c.id))
    .map((c) => ({ name: c.name, priceDelta: c.priceDelta || "0" }));
  return { name: item.name, price: item.price, qty: line.qty, choices };
}

/// Every line resolved, dropping any that no longer exist on the menu.
export function resolveCart(menu: Menu | null, cart: Cart): ResolvedLine[] {
  if (!menu) return [];
  return cart.map((l) => resolveLine(menu, l)).filter((l): l is ResolvedLine => !!l);
}

function resolvedWei(l: ResolvedLine): bigint {
  let unit = parseEther(l.price || "0");
  for (const c of l.choices) unit += parseEther(c.priceDelta || "0");
  return unit * BigInt(Math.max(0, Math.trunc(l.qty)));
}

/// orderValue (wei) for a cart against a menu. Must agree exactly with
/// `ticket.ts ticketTotalWei` over the same lines — the venue checks one against
/// the other, and a divergence would make every honest ticket look forged.
export function cartTotal(menu: Menu | null, cart: Cart): bigint {
  let total = 0n;
  for (const l of resolveCart(menu, cart)) {
    try {
      total += resolvedWei(l);
    } catch {
      /* skip malformed price */
    }
  }
  return total;
}

export function cartCount(cart: Cart): number {
  return cart.reduce((n, l) => n + Math.max(0, l.qty), 0);
}

// ── option validation ────────────────────────────────────────────────────────

/// Why a configuration can't be added, or null when it's fine.
export function selectionError(item: MenuItem, choices: string[]): string | null {
  const chosen = new Set(choices);
  for (const g of item.options ?? []) {
    const n = g.choices.filter((c) => chosen.has(c.id)).length;
    const min = g.min ?? (g.required ? 1 : 0);
    const max = g.max ?? g.choices.length;
    if (n < min) return `${g.name}: choose at least ${min}`;
    if (n > max) return `${g.name}: choose at most ${max}`;
  }
  return null;
}
