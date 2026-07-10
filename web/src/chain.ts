// Chain glue: provider, signer modes, contract handles, EIP-712 signing.
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  Wallet,
  ethers,
} from "ethers";
import deployed from "./deployed-addresses.json";
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

export const RPC_URL =
  deployed.network === "polkadotTestnet"
    ? "https://eth-rpc-testnet.polkadot.io/"
    : "http://127.0.0.1:8545";

export const readProvider = new JsonRpcProvider(RPC_URL, CHAIN_ID, {
  staticNetwork: true,
});

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
    const w = new Wallet(privateKey.trim(), readProvider);
    return { mode, address: w.address, signer: w };
  }
  // burner: persistent throwaway key in localStorage
  let key = localStorage.getItem(BURNER_KEY);
  if (!key) {
    key = Wallet.createRandom().privateKey;
    localStorage.setItem(BURNER_KEY, key);
  }
  const w = new Wallet(key, readProvider);
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

export const REVEAL_TYPES = {
  DropoffReveal: [
    { name: "orderId", type: "uint256" },
    { name: "lat", type: "int32" },
    { name: "lon", type: "int32" },
    { name: "salt", type: "uint256" },
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

export interface RevealAtt {
  orderId: string;
  lat: number;
  lon: number;
  salt: string;
  timestamp: number;
}

export async function signLocation(s: Session, att: LocationAtt): Promise<string> {
  return s.signer.signTypedData(eip712Domain(), LOCATION_TYPES, att);
}

export async function signReveal(s: Session, reveal: RevealAtt): Promise<string> {
  return s.signer.signTypedData(eip712Domain(), REVEAL_TYPES, reveal);
}

export function computeDropCommit(lat: number, lon: number, salt: string): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["int32", "int32", "uint256"], [lat, lon, salt])
  );
}

export function randomSalt(): string {
  return BigInt(ethers.hexlify(ethers.randomBytes(16))).toString();
}

// ---- attestation hand-off payloads (copy/paste or QR between parties) ----

export function encodePayload(kind: string, att: object, sig: string): string {
  return btoa(JSON.stringify({ v: 1, kind, att, sig }));
}

export function decodePayload(s: string): { kind: string; att: any; sig: string } {
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
