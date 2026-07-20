// QR handoff: show a signed attestation payload as a scannable code, and scan
// a counterparty's code with the rear camera. The QR encodes the exact same
// base64 string the copy/paste path uses, so scan and paste are fully
// interchangeable — the QR is just the fast path for a two-phone handoff.
import { useEffect, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import jsQR from "jsqr";
import { decodePayload } from "./chain";

// ---- show ----

/// Render `value` as a high-contrast QR. Always dark-on-white regardless of
/// app theme — a themed (low-contrast) QR does not scan.
export function QRShow({ value }: { value: string }) {
  const dataUrl = (() => {
    // typeNumber 0 = auto-pick the smallest version that fits; EC level L
    // keeps a ~420-byte payload from getting needlessly dense.
    const qr = qrcode(0, "L");
    qr.addData(value);
    qr.make();
    return qr.createDataURL(6, 4);
  })();
  return (
    <div className="qr-show">
      <img src={dataUrl} alt="handoff QR code" />
    </div>
  );
}

// ---- scan ----

// Chromium exposes a native, GPU-accelerated detector; Safari/iOS does not,
// so we fall back to jsQR over a canvas. Feature-detect at call time.
const NativeDetector: any = (globalThis as any).BarcodeDetector;

/// Camera QR scanner. Resolves `onResult` with the decoded string the first
/// time it reads a valid FARE payload (optionally matching `expectKind`);
/// random QR codes in frame are ignored so the scanner stays open until it
/// sees the real handoff code.
export function QRScan({
  onResult,
  onCancel,
  expectKind,
}: {
  onResult: (value: string) => void;
  onCancel: () => void;
  expectKind?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const nativeDetector = NativeDetector ? new NativeDetector({ formats: ["qr_code"] }) : null;

    const accept = (raw: string): boolean => {
      const text = raw.trim();
      if (!text) return false;
      try {
        const p = decodePayload(text); // validates version + shape
        if (expectKind && p.kind !== expectKind) return false;
      } catch {
        return false; // not a FARE payload — keep scanning
      }
      done = true;
      onResult(text);
      return true;
    };

    const tick = async () => {
      const video = videoRef.current;
      if (done || !video || video.readyState !== video.HAVE_ENOUGH_DATA) {
        if (!done) raf = requestAnimationFrame(tick);
        return;
      }
      try {
        if (nativeDetector) {
          const codes = await nativeDetector.detect(video);
          for (const c of codes) if (accept(c.rawValue)) return;
        } else if (ctx) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code && accept(code.data)) return;
        }
      } catch {
        /* transient decode error — try the next frame */
      }
      if (!done) raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        raf = requestAnimationFrame(tick);
      } catch (e: any) {
        setErr(
          e?.name === "NotAllowedError"
            ? "Camera permission denied — allow it, or paste the code instead."
            : `Camera unavailable: ${e?.message ?? e}`
        );
      }
    })();

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult, expectKind]);

  return (
    <div className="qr-scan">
      <video ref={videoRef} playsInline muted />
      <div className="qr-scan-frame" />
      {err && <div className="qr-scan-err">{err}</div>}
      <button className="btn ghost small qr-scan-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
