// The probe's actual checks, in the order a delivery would exercise them.
//
// This is a REHEARSAL, not a mock: it imports the same modules the driver flow
// uses (web/src/geo.ts, photoflow.ts, photo.ts) so a pass here means FARE's real
// dropoff path survives inside the mobile Polkadot App runtime. See
// docs/POLKADOT-PLATFORM-PLAN.md §4.7 (what this answers) and §4.1 (why the
// EIP-712 step signs with a local key rather than the host signer).

import { Wallet, verifyTypedData } from "ethers";
import { createApp, isInsideContainerSync, type App } from "@parity/product-sdk";

import { getPosition, snapToGrid, fmtCoord, toMicroDeg } from "../../../web/src/geo";
import { compressImage } from "../../../web/src/photoflow";
import { newPhotoKey, sealPhoto, openPhoto } from "../../../web/src/photo";
import deployed from "../../../web/src/deployed-addresses.json";

export type Status = "pass" | "fail" | "skip";
export interface Outcome {
  status: Status;
  detail: string;
  /** Rendered under the detail line as a preformatted block. */
  data?: string;
  /** Milliseconds the check took — time-to-fix matters for geolocation. */
  ms?: number;
}
export interface Check {
  id: string;
  title: string;
  /** Why FARE cares. Shown in the UI so a failure is self-explaining. */
  why: string;
  /** Needs a user gesture (camera/file picker) — the UI gives these a button. */
  manual?: boolean;
  run: (ctx: Ctx) => Promise<Outcome>;
}

/** Carried between checks: each stage feeds the next, exactly as in a delivery. */
export interface Ctx {
  app?: App;
  jpeg?: Uint8Array;
  photoKey?: string;
  sealed?: { iv: string; ct: string };
  cid?: string;
  /** Set when the round-trip recovers a viewable image. */
  recoveredUrl?: string;
}

const enc = new TextEncoder();
const kb = (n: number) => `${(n / 1024).toFixed(1)} KiB`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t0)];
}

// ---- 1. runtime ------------------------------------------------------------

const runtime: Check = {
  id: "runtime",
  title: "Runtime + host detection",
  why: "Confirms Products really do run inside the mobile Polkadot App, and that the Host API is reachable from here (plan §4.7).",
  async run(ctx) {
    const inContainer = isInsideContainerSync();
    const app = await createApp({ name: "fare-device-probe" });
    ctx.app = app;

    let accounts = "none (wallet.connect failed)";
    try {
      const r = await app.wallet.connect();
      accounts = r.accounts.map((a) => a.address).join(", ") || "none returned";
    } catch (e) {
      accounts = `connect threw: ${(e as Error).message}`;
    }

    // Ring VRF alias is container-only and is the one identity primitive that
    // does NOT link a user across orders — relevant to plan §4.3/§4.4.
    let alias = "n/a";
    try {
      alias = app.wallet.getAnonymousAlias() ?? "null (not in container mode)";
    } catch (e) {
      alias = `threw: ${(e as Error).message}`;
    }

    return {
      status: inContainer ? "pass" : "fail",
      detail: inContainer
        ? "Running inside the Polkadot host container."
        : "NOT in a host container — this is a plain browser. Open via the Polkadot App to get a real answer.",
      data: [
        `isInsideContainerSync : ${inContainer}`,
        `userAgent             : ${navigator.userAgent}`,
        `accounts              : ${accounts}`,
        `anonymousAlias (RVRF) : ${alias}`,
        `cloudStorage          : ${ctx.app?.cloudStorage ? "available" : "null (disabled)"}`,
      ].join("\n"),
    };
  },
};

// ---- 2. geolocation --------------------------------------------------------

const geolocation: Check = {
  id: "geo",
  title: "Geolocation API",
  why: "Every pickup attestation is signed over a device GPS fix (web/src/geo.ts). No geolocation, no delivery — this is the hard gate.",
  async run() {
    if (!("geolocation" in navigator)) {
      return { status: "fail", detail: "navigator.geolocation is absent in this runtime." };
    }
    try {
      const [pos, ms] = await timed(getPosition);
      const snapped = snapToGrid(pos);
      return {
        status: "pass",
        ms,
        detail: `Fix acquired in ${ms} ms.`,
        data: [
          `raw      : ${fmtCoord(pos)}  (${pos.lat}, ${pos.lon} µdeg)`,
          `snapped  : ${fmtCoord(snapped)}  (~33 m pickup grid, docs/PRIVACY.md risk #6)`,
        ].join("\n"),
      };
    } catch (e) {
      return { status: "fail", detail: (e as Error).message };
    }
  },
};

// ---- 3. camera -------------------------------------------------------------

/** Resolve a still image from the camera, preferring getUserMedia. */
async function captureStill(): Promise<{ blob: Blob; via: string }> {
  if (navigator.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      video.playsInline = true;
      await video.play();
      // One frame is enough; a delivery photo is a single still.
      await new Promise((r) => setTimeout(r, 350));
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")!.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      const blob: Blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", 0.9)
      );
      return { blob, via: "getUserMedia (environment camera)" };
    } catch (e) {
      // Fall through to the file-input path — on some runtimes getUserMedia is
      // blocked but <input capture> still reaches the native camera.
      console.warn("getUserMedia failed, trying capture input:", e);
    }
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = "environment";
    input.onchange = () => {
      const f = input.files?.[0];
      f ? resolve({ blob: f, via: "<input type=file capture> fallback" }) : reject(new Error("no file chosen"));
    };
    input.oncancel = () => reject(new Error("capture cancelled"));
    input.click();
  });
}

const camera: Check = {
  id: "camera",
  title: "Camera capture → compressImage",
  why: "Proof-of-delivery photos (docs/PHOTOS.md). Runs the real compressImage — the canvas re-encode is what strips EXIF/GPS, so this also proves the privacy step works here.",
  manual: true,
  async run(ctx) {
    try {
      const { blob, via } = await captureStill();
      const [jpeg, ms] = await timed(() => compressImage(blob));
      ctx.jpeg = jpeg;
      return {
        status: "pass",
        ms,
        detail: `Captured via ${via}, compressed in ${ms} ms.`,
        data: [
          `captured  : ${kb(blob.size)} (${blob.type})`,
          `compressed: ${kb(jpeg.length)} JPEG, max dim 800px, q0.6`,
          `reduction : ${(100 - (100 * jpeg.length) / blob.size).toFixed(1)}%`,
          `EXIF      : stripped by canvas re-encode (construction, not a filter)`,
        ].join("\n"),
      };
    } catch (e) {
      return { status: "fail", detail: (e as Error).message };
    }
  },
};

// ---- 4. seal ---------------------------------------------------------------

const seal: Check = {
  id: "seal",
  title: "Seal under a crypto-shred key",
  why: "web/src/photo.ts. The fresh random AES-256-GCM key is what makes expiry guaranteed rather than best-effort — storage never sees plaintext.",
  async run(ctx) {
    const bytes = ctx.jpeg ?? enc.encode(`fare-device-probe placeholder ${Date.now()}`);
    const usingPlaceholder = !ctx.jpeg;
    try {
      const key = newPhotoKey();
      const [sealed, ms] = await timed(() => sealPhoto(key, bytes));
      ctx.photoKey = key;
      ctx.sealed = sealed;
      return {
        status: "pass",
        ms,
        detail: usingPlaceholder
          ? "Sealed a placeholder (no photo captured — run the camera check for the real thing)."
          : `Sealed ${kb(bytes.length)} in ${ms} ms.`,
        data: [`iv : ${sealed.iv}`, `ct : ${sealed.ct.length / 2 - 1} bytes`].join("\n"),
      };
    } catch (e) {
      return { status: "fail", detail: (e as Error).message };
    }
  },
};

// ---- 5. EIP-712 ------------------------------------------------------------

// Mirrors web/src/chain.ts:372-400 — kept local so the probe doesn't drag in
// chain.ts's snarkjs/ABI graph. If those diverge this check still passes but
// stops proving anything; re-copy from chain.ts if you touch the attestation.
const EIP712_DOMAIN = {
  name: "FareSettlement",
  version: "1",
  chainId: (deployed as { chainId: number }).chainId,
  verifyingContract: (deployed as { addresses: Record<string, string> }).addresses.settlement,
};
const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" },
    { name: "phase", type: "uint8" },
    { name: "actor", type: "address" },
    { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

const eip712: Check = {
  id: "eip712",
  title: "EIP-712 attestation with a local burner",
  why: "Plan §4.1: the Polkadot App signs sr25519 and cannot produce an ecrecover-able signature, so attestations must sign with an app-local secp256k1 key. This proves that still works inside the host runtime.",
  async run() {
    try {
      const burner = Wallet.createRandom();
      const att = {
        orderId: "424242",
        phase: 1,
        actor: burner.address,
        posCommit: "0x" + "11".repeat(32),
        timestamp: Math.floor(Date.now() / 1000),
      };
      const [sig, ms] = await timed(() => burner.signTypedData(EIP712_DOMAIN, DRIVER_COMMIT_TYPES, att));
      const recovered = verifyTypedData(EIP712_DOMAIN, DRIVER_COMMIT_TYPES, att, sig);
      const ok = recovered.toLowerCase() === burner.address.toLowerCase();
      return {
        status: ok ? "pass" : "fail",
        ms,
        detail: ok
          ? `Signed and recovered in ${ms} ms — the contract's ecrecover would accept this.`
          : `Recovery mismatch: expected ${burner.address}, got ${recovered}.`,
        data: [
          `verifyingContract : ${EIP712_DOMAIN.verifyingContract}`,
          `chainId           : ${EIP712_DOMAIN.chainId}`,
          `burner            : ${burner.address}`,
          `recovered         : ${recovered}`,
        ].join("\n"),
      };
    } catch (e) {
      return { status: "fail", detail: (e as Error).message };
    }
  },
};

// ---- 6/7. Bulletin round trip ---------------------------------------------

const bulletinUpload: Check = {
  id: "bulletin-up",
  title: "Bulletin upload",
  why: "Plan Phase 2 replaces /api/photo with Bulletin. This is also the live test of the S1 authorization — a quota failure surfaces here as a concrete error.",
  async run(ctx) {
    const cs = ctx.app?.cloudStorage;
    if (!cs) return { status: "skip", detail: "cloudStorage unavailable — run the runtime check first." };
    if (!ctx.sealed) return { status: "skip", detail: "nothing sealed yet — run the seal check first." };

    const payload = enc.encode(JSON.stringify(ctx.sealed));
    try {
      const [res, ms] = await timed(() => cs.upload(payload));
      if (!res.ok) {
        return {
          status: "fail",
          ms,
          detail: "upload returned err — most likely the storage authorization.",
          data: JSON.stringify(res.error, null, 2),
        };
      }
      ctx.cid = res.value;
      return {
        status: "pass",
        ms,
        detail: `Stored ${kb(payload.length)} in ${ms} ms.`,
        data: [`CID: ${res.value}`, `NOTE: ~2-week TTL. Not renewing is the expiry (plan §4.6).`].join("\n"),
      };
    } catch (e) {
      return { status: "fail", detail: (e as Error).message };
    }
  },
};

const bulletinRoundTrip: Check = {
  id: "bulletin-down",
  title: "Bulletin fetch → CID verify → decrypt",
  why: "Closes the loop: content addressing proves the host returned the right bytes, and openPhoto proves the E2E seal survived the trip.",
  async run(ctx) {
    const cs = ctx.app?.cloudStorage;
    if (!cs || !ctx.cid || !ctx.photoKey) {
      return { status: "skip", detail: "needs a successful upload first." };
    }
    try {
      const [res, ms] = await timed(() => cs.fetch(ctx.cid!));
      if (!res.ok) return { status: "fail", ms, detail: "fetch returned err.", data: JSON.stringify(res.error, null, 2) };

      const recomputed = await cs.computeCid(res.value);
      const cidOk = recomputed === ctx.cid;

      const sealed = JSON.parse(new TextDecoder().decode(res.value));
      const plain = await openPhoto(ctx.photoKey, sealed);
      if (ctx.jpeg) {
        ctx.recoveredUrl = URL.createObjectURL(new Blob([plain as BlobPart], { type: "image/jpeg" }));
      }

      return {
        status: cidOk ? "pass" : "fail",
        ms,
        detail: cidOk
          ? `Round-tripped in ${ms} ms; CID verified; ${kb(plain.length)} decrypted.`
          : "CID MISMATCH — the host returned bytes that do not hash to the requested CID.",
        data: [`requested : ${ctx.cid}`, `recomputed: ${recomputed}`].join("\n"),
      };
    } catch (e) {
      return { status: "fail", detail: (e as Error).message };
    }
  },
};

export const CHECKS: Check[] = [
  runtime,
  geolocation,
  camera,
  seal,
  eip712,
  bulletinUpload,
  bulletinRoundTrip,
];
