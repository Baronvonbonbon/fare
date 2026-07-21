// Chain glue: provider, signer modes, contract handles, EIP-712 signing.
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  Wallet,
  ethers,
} from "ethers";
import deployed from "./deployed-addresses.json";
import { MicroDeg } from "./geo";
import { positionCommit } from "./zk";
import {
  DISPUTES_ABI,
  DRIVERS_ABI,
  ORDERS_ABI,
  ROUTER_ABI,
  SETTLEMENT_ABI,
  VAULT_ABI,
  VENUES_ABI,
} from "./abi";

export const ADDRESSES = deployed.addresses as Record<string, string>;
export const CHAIN_ID = deployed.chainId as number;
const PASEO_CHAIN_ID = 420420417;

// ---- node selection: the trust gradient ----
// hosted        → centralized eth-rpc gateway (convenient, trusted)
// pine-daemon   → local pine-rpc daemon: smoldot light client behind a local
//                 eth-rpc port; reads are Merkle-proof-verified
// pine-embedded → PineProvider runs the smoldot light client INSIDE this tab
//                 (experimental; Paseo only, ~10-60s first sync)

export type NodeMode = "hosted" | "pine-daemon" | "pine-embedded";

const NODE_MODE_KEY = "fare.node.mode";
const NODE_URL_KEY = "fare.node.url";

export function getNodeMode(): NodeMode {
  const m = localStorage.getItem(NODE_MODE_KEY) as NodeMode | null;
  if (m === "pine-embedded" && !embeddedAvailable()) return "hosted";
  return m ?? "hosted";
}

export function getNodeUrl(): string {
  return localStorage.getItem(NODE_URL_KEY) ?? "http://127.0.0.1:8545";
}

/// Embedded light client only makes sense on a real public chain.
export function embeddedAvailable(): boolean {
  return CHAIN_ID === PASEO_CHAIN_ID;
}

/// Persist the node choice and reload — providers and signer sessions are
/// bound at module scope, so a clean reload is the honest switch.
export function setNode(mode: NodeMode, url?: string): void {
  localStorage.setItem(NODE_MODE_KEY, mode);
  if (url) localStorage.setItem(NODE_URL_KEY, url);
  window.location.reload();
}

export function nodeLabel(): string {
  switch (getNodeMode()) {
    case "pine-daemon":
      return "pine daemon";
    case "pine-embedded":
      return "light client";
    default:
      return "hosted rpc";
  }
}

/// Names resolvable through the FareGovernanceRouter registry. The deploy
/// file is only the bootstrap: at runtime we re-resolve every address from
/// the on-chain registry, so a router-driven upgrade re-points this client
/// automatically — no redeploy of the web app.
const REGISTRY_NAMES = [
  "pauseRegistry",
  "vault",
  "drivers",
  "venues",
  "orders",
  "settlement",
  "disputes",
] as const;

let registrySynced = false;

export async function syncAddressesFromRouter(): Promise<boolean> {
  if (registrySynced || !ADDRESSES.router) return registrySynced;
  try {
    const router = new Contract(ADDRESSES.router, ROUTER_ABI, readProvider);
    const live = await Promise.all(
      REGISTRY_NAMES.map((n) => router.currentAddrOf(ethers.encodeBytes32String(n)))
    );
    REGISTRY_NAMES.forEach((n, i) => {
      if (live[i] && live[i] !== ethers.ZeroAddress) ADDRESSES[n] = live[i];
    });
    registrySynced = true;
  } catch (e) {
    console.warn("Router address sync failed; using deploy-file addresses", e);
  }
  return registrySynced;
}

const HOSTED_URL =
  deployed.network === "polkadotTestnet"
    ? "https://eth-rpc-testnet.polkadot.io/"
    : "http://127.0.0.1:8545";

export const RPC_URL = (() => {
  switch (getNodeMode()) {
    case "pine-daemon":
      return getNodeUrl();
    case "pine-embedded":
      return "smoldot (in-browser)";
    default:
      return HOSTED_URL;
  }
})();

/// The active read provider. For hosted/pine-daemon it's ready at module
/// load; for pine-embedded it's a placeholder until initNode() swaps in the
/// connected light-client provider.
export let readProvider: ethers.AbstractProvider = new JsonRpcProvider(
  getNodeMode() === "pine-daemon" ? getNodeUrl() : HOSTED_URL,
  CHAIN_ID,
  { staticNetwork: true }
);

/// Broadcast provider for local-key wallets (burner / pasted key). Reads may
/// go through a light client, but light clients can't broadcast — so we always
/// SEND transactions through the hosted eth-rpc gateway. This is the standard
/// light-client split: verify reads locally, submit through a gateway.
export const sendProvider: JsonRpcProvider = new JsonRpcProvider(HOSTED_URL, CHAIN_ID, {
  staticNetwork: true,
});

export type PineSyncStep = string;
let nodeInitPromise: Promise<void> | null = null;

/// Boot the selected node. Hosted/daemon modes resolve immediately; the
/// embedded mode dynamically imports pine-rpc (keeps smoldot's WASM out of
/// the main bundle), starts the in-tab light client, and swaps the read
/// provider once the first finalized block arrives.
export function initNode(onStep?: (step: PineSyncStep) => void): Promise<void> {
  if (nodeInitPromise) return nodeInitPromise;
  nodeInitPromise = (async () => {
    if (getNodeMode() !== "pine-embedded") return;
    onStep?.("loading light client…");
    const { PineProvider } = await import("pine-rpc");
    const pine = new PineProvider({ chain: "paseo-asset-hub" });
    await pine.connect((step: any) => onStep?.(String(step?.label ?? step)));
    readProvider = new BrowserProvider(pine as any, CHAIN_ID);
    onStep?.("light client synced");
  })();
  return nodeInitPromise;
}

export type SignerMode = "injected" | "burner" | "key";

export interface Session {
  mode: SignerMode;
  address: string;
  signer: ethers.Signer & {
    signTypedData(domain: any, types: any, value: any): Promise<string>;
  };
}

const BURNER_KEY = "fare.burner.key";

export async function connect(mode: SignerMode, privateKey?: string): Promise<Session> {
  if (mode === "injected") {
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No injected wallet found");
    const provider = new BrowserProvider(eth);
    await provider.send("eth_requestAccounts", []);
    const signer = await provider.getSigner();
    return { mode, address: await signer.getAddress(), signer: signer as any };
  }
  if (mode === "key") {
    if (!privateKey) throw new Error("Private key required");
    // Bind to sendProvider so signing/broadcast works regardless of read node.
    const w = new Wallet(privateKey.trim(), sendProvider);
    return { mode, address: w.address, signer: w };
  }
  // burner: persistent throwaway key in localStorage
  let key = localStorage.getItem(BURNER_KEY);
  if (!key) {
    key = Wallet.createRandom().privateKey;
    localStorage.setItem(BURNER_KEY, key);
  }
  const w = new Wallet(key, sendProvider);
  return { mode, address: w.address, signer: w };
}

export function contracts(runner: ethers.ContractRunner = readProvider) {
  return {
    orders: new Contract(ADDRESSES.orders, ORDERS_ABI, runner),
    venues: new Contract(ADDRESSES.venues, VENUES_ABI, runner),
    drivers: new Contract(ADDRESSES.drivers, DRIVERS_ABI, runner),
    settlement: new Contract(ADDRESSES.settlement, SETTLEMENT_ABI, runner),
    vault: new Contract(ADDRESSES.vault, VAULT_ABI, runner),
    disputes: new Contract(ADDRESSES.disputes, DISPUTES_ABI, runner),
  };
}

// ---- event-based order discovery ----
// Enumerate order IDs from OrderCreated logs instead of scanning 1..nextOrderId
// and reading every struct. Callers keep a block cursor and only re-read the
// structs of still-active orders, so steady-state refresh cost tracks the
// number of *live* orders, not the all-time total.

export interface DiscoveredOrder {
  id: bigint;
  venueId: bigint;
  customer: string;
  block: number;
}

export async function currentBlock(): Promise<number> {
  return readProvider.getBlockNumber();
}

function ordersContract(): Contract {
  return new Contract(ADDRESSES.orders, ORDERS_ABI, readProvider);
}

// Paseo's eth-rpc rejects `null` topic placeholders and mishandles the `[]`
// wildcard, so we cannot server-side filter on a non-leading indexed topic
// (customer/venueId/driver). Instead we fetch the full event stream by topic0
// (one cheap getLogs) and let callers filter the decoded args client-side —
// which still scopes the expensive part, the per-order struct reads.

/// All OrderCreated logs in range, decoded (id, customer, venueId).
export async function discoverOrders(fromBlock: number, toBlock: number): Promise<DiscoveredOrder[]> {
  const orders = ordersContract();
  const logs = await orders.queryFilter(orders.filters.OrderCreated(), fromBlock, toBlock);
  return logs.map((l: any) => ({
    id: l.args.orderId as bigint,
    venueId: l.args.venueId as bigint,
    customer: l.args.customer as string,
    block: l.blockNumber as number,
  }));
}

export interface Assignment {
  id: bigint;
  driver: string;
}

/// All OrderAssigned logs in range, decoded (id, driver) — for a driver's own
/// in-flight jobs, filtered client-side.
export async function discoverAssignments(fromBlock: number, toBlock: number): Promise<Assignment[]> {
  const orders = ordersContract();
  const logs = await orders.queryFilter(orders.filters.OrderAssigned(), fromBlock, toBlock);
  return logs.map((l: any) => ({ id: l.args.orderId as bigint, driver: l.args.driver as string }));
}

// ---- region-scoped discovery (Phase 2: OrderRegion) ----
// region is the LEADING indexed topic, so — unlike customer/venue/driver — it
// CAN be server-side filtered on Paseo. A driver fetches only the orders whose
// pickup falls in the grid cells covering their radius, instead of the whole
// OrderCreated stream. Must match GeoLib.regionOf exactly.

const REGION_CELL = 500_000; // microdegrees (~0.5°), == GeoLib.REGION_CELL

const cellRegion = (latCell: number, lonCell: number): string =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["int256", "int256"], [latCell, lonCell]));

/// Region ids for every grid cell overlapping the radius around `center`
/// (padded a cell each way so edges/truncation can't miss one).
export function regionsCovering(center: MicroDeg, radiusKm: number): string[] {
  const r = radiusKm * 1000;
  const dLat = (r / 111_320) * 1e6;
  const cosLat = Math.max(Math.cos(((center.lat / 1e6) * Math.PI) / 180), 1e-6);
  const dLon = (r / (111_320 * cosLat)) * 1e6;
  const latMin = Math.trunc((center.lat - dLat) / REGION_CELL) - 1;
  const latMax = Math.trunc((center.lat + dLat) / REGION_CELL) + 1;
  const lonMin = Math.trunc((center.lon - dLon) / REGION_CELL) - 1;
  const lonMax = Math.trunc((center.lon + dLon) / REGION_CELL) + 1;
  const out: string[] = [];
  for (let la = latMin; la <= latMax; la++) for (let lo = lonMin; lo <= lonMax; lo++) out.push(cellRegion(la, lo));
  return out;
}

/// Order IDs whose pickup region is one of `regions` (server-side filtered).
export async function orderIdsInRegions(regions: string[], from: number, to: number): Promise<bigint[]> {
  if (regions.length === 0) return [];
  const c = ordersContract();
  const perRegion = await Promise.all(
    regions.map((rg) => c.queryFilter(c.filters.OrderRegion(rg), from, to))
  );
  return perRegion.flat().map((l: any) => l.args.orderId as bigint);
}

// ---- EIP-712 attestations ----

/// Computed lazily: the domain binds the LIVE settlement address, which the
/// router sync may have re-pointed after an upgrade.
export function eip712Domain() {
  return {
    name: "FareSettlement",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: ADDRESSES.settlement,
  };
}

export const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" },
    { name: "phase", type: "uint8" },
    { name: "actor", type: "address" },
    { name: "lat", type: "int32" },
    { name: "lon", type: "int32" },
    { name: "timestamp", type: "uint64" },
  ],
};

export const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" },
    { name: "phase", type: "uint8" },
    { name: "actor", type: "address" },
    { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

export interface LocationAtt {
  orderId: string;
  phase: number;
  actor: string;
  lat: number;
  lon: number;
  timestamp: number;
}

export interface DriverCommitAtt {
  orderId: string;
  phase: number;
  actor: string;
  posCommit: string; // Poseidon(drvLatEnc, drvLonEnc, drvSalt)
  timestamp: number;
}

export async function signLocation(s: Session, att: LocationAtt): Promise<string> {
  return s.signer.signTypedData(eip712Domain(), LOCATION_TYPES, att);
}

export async function signDriverCommit(s: Session, att: DriverCommitAtt): Promise<string> {
  return s.signer.signTypedData(eip712Domain(), DRIVER_COMMIT_TYPES, att);
}

/// Poseidon(latEnc, lonEnc, salt) — the ZK-native drop commitment (never
/// revealed on-chain; proven in zero knowledge at dropoff). See web/src/zk.ts.
export function computeDropCommit(lat: number, lon: number, salt: string): string {
  return positionCommit(lat, lon, salt);
}

export function randomSalt(): string {
  return BigInt(ethers.hexlify(ethers.randomBytes(16))).toString();
}

// ---- attestation hand-off payloads (copy/paste or QR between parties) ----

/// `pos` (optional) carries plaintext coordinates + salt for the ZK dropoff
/// handoff — the driver shares their position with the customer face-to-face so
/// the customer can build the proximity proof locally. It rides inside the QR
/// exchanged in person; it never goes on-chain.
export function encodePayload(
  kind: string,
  att: object,
  sig: string,
  pos?: { lat: number; lon: number; salt: string }
): string {
  return btoa(JSON.stringify({ v: 1, kind, att, sig, pos }));
}

export function decodePayload(s: string): {
  kind: string;
  att: any;
  sig: string;
  pos?: { lat: number; lon: number; salt: string };
} {
  const o = JSON.parse(atob(s.trim()));
  if (o.v !== 1) throw new Error("Unknown payload version");
  return o;
}

export const fmt = (wei: bigint) => {
  const s = ethers.formatEther(wei);
  return s.includes(".") ? s.replace(/(\.\d{4})\d+$/, "$1").replace(/\.?0+$/, "") || "0" : s;
};

export const parse = (v: string) => ethers.parseEther(v === "" ? "0" : v);

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ---- burner gas faucet (serverless drip) ----
// The drip key lives only in the /api/drip Cloudflare Function (server-side
// secret). The client just asks it to top up a low burner; every tx costs
// native PAS, so a fresh burner needs gas before it can do anything.

/// Below this native balance a burner can't reliably cover a tx — auto-drip
/// on connect and surface a manual top-up.
export const DRIP_MIN = ethers.parseEther("1");

export async function nativeBalance(address: string): Promise<bigint> {
  return readProvider.getBalance(address);
}

/// Cheap liveness probe for the active read provider. Rejects if the selected
/// node is unreachable (e.g. "pine daemon" chosen with no daemon running) so
/// the UI can surface it instead of silently showing stale zeros.
export async function pingNode(): Promise<number> {
  return readProvider.getBlockNumber();
}

export interface DripResult {
  funded?: boolean;
  txHash?: string;
  reason?: string;
  error?: string;
  configured?: boolean;
}

/// Ask the serverless faucet to top up `address`. Resolves with the endpoint's
/// verdict; throws only on network failure. A 503 `{ configured:false }` means
/// the operator hasn't set DRIP_PRIVATE_KEY yet, so callers fall back to the
/// public faucet.
export async function requestDrip(address: string): Promise<DripResult> {
  const res = await fetch("/api/drip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  return (await res.json().catch(() => ({}))) as DripResult;
}
