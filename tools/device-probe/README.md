# FARE device probe

Answers the questions blocking [`docs/POLKADOT-PLATFORM-PLAN.md`](../../docs/POLKADOT-PLATFORM-PLAN.md)
Phase 1 and Phase 2 — with evidence from the actual device, not from docs.

Two halves:

| | Runs on | Answers |
|---|---|---|
| **Browser probe** (`src/`) | The phone, inside the Polkadot App | §4.7 device APIs, §4.1 signing split, Phase 2 Bulletin round-trip |
| **Allowance probe** (`allowance-probe.mjs`) | A workstation, QR-paired to the phone | **S1** Bulletin allowance, **S3** Statement Store allowance, per-order account derivation |

It is a **rehearsal, not a mock**: the browser probe imports `web/src/geo.ts`,
`web/src/photoflow.ts`, and `web/src/photo.ts` directly, so a pass means FARE's real
dropoff path survives the mobile runtime.

---

## Browser probe

```bash
npm install
npm run dev      # local sanity check — the runtime check will correctly FAIL
                 # ("not in a host container"), everything else should pass
npm run build    # → dist/
```

Seven checks, in the order a delivery exercises them:

1. **Runtime + host detection** — `isInsideContainerSync()`, account list, and the Ring VRF
   anonymous alias (`getAnonymousAlias()`, container-only). Fails outside the Polkadot App by
   design; that failure is the control.
2. **Geolocation** — real `getPosition()` + `snapToGrid()`. Reports time-to-fix and the ~33 m
   pickup grid. **This is the hard gate: no geolocation, no delivery.**
3. **Camera → `compressImage`** — `getUserMedia` with an `<input capture>` fallback, then the
   real downscale/EXIF-strip. Needs a tap, so "Run all" skips it.
4. **Seal** — real `newPhotoKey()` + `sealPhoto()`.
5. **EIP-712 with a local burner** — signs a `DriverCommitAttestation` against the live
   `FareSettlement` domain and recovers it. Proves §4.1's claim that app-local secp256k1 signing
   still works inside the host runtime.
6. **Bulletin upload** — `cloudStorage.upload()`. An authorization problem surfaces here as a
   concrete error.
7. **Bulletin fetch → CID verify → decrypt** — closes the loop and renders the recovered photo.

"Copy report" produces a pasteable summary; if the clipboard is blocked (common in embedded
runtimes) it renders the report inline instead.

### Publishing

```bash
npm run build
pad ./dist <name>.dot --env devnet --mnemonic "$MNEMONIC"
```

Use a **throwaway name**. `pad` overwrites the target's DotNS `contenthash`, so publishing to a
name you use for anything else takes it over until you republish.

---

## Allowance probe

```bash
node allowance-probe.mjs [--product fare-device-probe] [--index 1]
```

Prints a pairing QR, waits for the Polkadot App to scan it, then reads:

- `hasBulletinAllowance` → **S1**
- `hasStatementStoreAllowance` → **S3**
- `deriveProductPublicKey` at index 0 and index N → whether per-order accounts are derivable (§4.1)

Read-only. Nothing is written on-chain and no key touches the machine — which is the point: this
same pairing is what should replace the raw `DEPLOYER_PRIVATE_KEY` in `scripts/deploy.ts` and the
`upgrade-*.ts` scripts.

---

## Findings already banked (before anyone runs it)

Two things fell out of building this, both recorded in the plan:

- **`AutoSigning` reports `NotAvailable` on both Android and iOS wallets** — documented in
  `@parity/product-sdk-terminal`'s own type declarations. Every host-routed signature needs a user
  tap. That is independent corroboration of §4.1: GPS attestations cannot go through the host
  signer, regardless of the sr25519/`ecrecover` problem.
- **A trivial SDK app builds to 6.7 MB** (2.2 MB gzipped, 35 files), almost all of it PAPI chain
  metadata — Kusama, Polkadot, and devnet Asset Hub metadata are bundled alongside Paseo. `pad`
  chunks at ~2 MiB with a ~8 MiB per-transaction limit and **chunked uploads are non-atomic**, so
  Phase 1 should trim descriptors to the chains FARE actually uses before publishing.

## Caveat

The EIP-712 domain and types in `src/checks.ts` are copied from `web/src/chain.ts` rather than
imported, because importing `chain.ts` drags in the snarkjs and ABI graph. If you change the
attestation shape, re-copy them — otherwise this check keeps passing while proving nothing.
