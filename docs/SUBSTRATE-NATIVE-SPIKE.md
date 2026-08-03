# Substrate-native client — spike findings

Can the PWA talk to FARE's contracts through the **substrate** toolchain
(`@polkadot/api` / PAPI against `pallet-revive`) instead of ethers-over-eth-rpc?

Run it yourself: `node scripts/substrate-native-spike.mjs`
(env: `AH_WSS`, `ORDER_ID`, `EVM_ADDRESS`, `SUBSTRATE_SEED`).

Measured **2026-08-01** against Paseo Asset Hub, spec `2004002`, orders
`0x9eD223784CacbE61369d345CE99a2f89f15D248F`.

## Why bother

Not novelty. The eth-rpc compatibility layer has cost this repo a running tax,
all of it visible in the code:

- `contracts/lib/PaseoSafeSender.sol` exists solely for an eth-rpc denomination bug.
- Nonces must be fetched with the `latest` tag; ethers' default `pending` errors
  with "could not coalesce error".
- `eth_getLogs` rejects `null` topic placeholders and mishandles `[]`, so no
  non-leading indexed topic can be filtered server-side — which is why
  `OrderRegion` indexes `region` **first** and why customer/driver filtering
  happens client-side.
- `gasLimit × maxFeePerGas` is reserved up front, so an over-large gasLimit
  bricks a small account.

None of these are chain problems. They are all translation-layer problems.

There is a second prize: **smoldot is substrate**. Today the in-browser light
client is shimmed behind `pine-rpc` plus a `BrowserProvider` faking eth-rpc
(`web/src/chain.ts:199`). PAPI speaks to smoldot directly, which makes the
trust-minimized path first-class instead of a compatibility sandwich.

## Verdict

| | Result |
|---|---|
| Runtime surface | **Present.** `revive.call`, `revive.mapAccount`, and the `ReviveApi` runtime API (`call`, `address`, `accountId`, `nonce`, `getStorage`, `ethTransact`, …). |
| ABI reads via `ReviveApi_call` | **Round-trip exactly.** `statusOf(1)` decoded to `1 (Open)`; the 16-field `orders(1)` struct decoded to the right customer, venueId and orderValue. Single-word and struct returns both survive. |
| Write path via `revive.call` | **Dispatches.** A `commitBid(uint256,bytes32,bytes32)` dry-run executed cleanly from a substrate origin. |
| Contract changes needed | **None.** This is a client transport swap. |

So the port is mechanical. Three constraints shape how it must be done.

## Finding 1 — a substrate account is a *different* address

`ReviveApi_address(AccountId32)` gives the H160 the contract will see as
`msg.sender`. For `//Alice` (`5Grwva…`) that is
**`0x9621DDe636dE098B43Efb0fA9b61fAcFE328F99D`** — unrelated to any secp256k1
key, because it is derived from the AccountId32, not recovered from a signature.

Everything in FARE is keyed by `msg.sender`: `venuesByOperator`,
`drivers[address]`, `orders.customer`, `FareVault.balanceOf`. A substrate-native
client is therefore **a different user** than the ethers client for the same
human. The consequence is not a bug to fix but a sequencing constraint:

> Cut over per role, deliberately. Do **not** run both clients against one
> deployment, or a driver's stake and reputation fork across two addresses with
> no way to merge them.

With one venue and a handful of drivers, re-registration is cheap — which argues
for doing the cutover **during** the pilot rather than after it.

Pass `EVM_ADDRESS=0x…` to the spike to print the contrast explicitly.

## Finding 2 — there is no anonymous read

This one was not anticipated and it changes the client design.

An **unmapped** `AccountId32` origin cannot even perform a *view* call:

```
statusOf(1) from 0x00…00 → {"module":{"index":100,"error":"0x2b000000"}}
                          → revive.AccountUnmapped
```

`revive.mapAccount` must have been called for that account (it takes a deposit)
before it can touch a contract at all — reads included. eth-rpc has no
equivalent: `eth_call` from the zero address is free and universal, and the whole
discovery path (`discoverOrders`, `syncAddressesFromRouter`, the venue/menu
board) relies on reading before anyone has connected a wallet.

Three ways out, in preference order:

1. **`ReviveApi_getStorage`** — read contract storage directly, no origin, no
   mapping. Costs a storage-layout dependency the ABI currently hides, so it
   suits a few hot reads (`statusOf`, `nextOrderId`), not everything.
2. **Keep a well-known mapped read account** in the client and use it as the
   origin for every view call. Simple, and it leaks nothing (the origin of a
   dry-run is not published), but it needs one funded+mapped account to exist.
3. **Hybrid**: reads over eth-rpc, writes over `revive.call`. Defeats most of the
   point — the eth-rpc quirks listed above are nearly all on the read path.

Whichever is chosen, **onboarding gains a step**: a new user must be mapped
before their first action, and mapping costs a deposit. The relay's sponsored
onboarding (`sponsorOnboarding` in `web/src/relay.ts`, `RELAY-SPONSORSHIP.md`) is
the natural place to absorb it.

## Finding 3 — the EIP-712 keys do not move

`FareSettlement._verifyLocationSig` and `_verifyDriverCommitSig`
(`contracts/FareSettlement.sol:288,307`) do:

```solidity
require(ECDSA.recover(digest, sig) == att.actor, "bad-signature");
```

An sr25519 account cannot produce a signature that `ecrecover`s. The same holds
for the EIP-2771 `FareForwarder` and `FareVault.withdrawFor`, both of which
verify EIP-712 signatures on-chain.

So the migration is **transport and payer identity only**. The GPS attestation
key, the venue hot signer, and the driver's settlement key stay device-held
secp256k1 keys. This is not a compromise — the venue hot signer and the driver
GPS key are already separate from whoever pays gas, so the architecture already
has the seam.

## What a port would touch

`web/src/chain.ts` is already the seam: `readProvider`, `sendProvider`,
`connect()`, `contracts()`. Introduce a backend interface with two
implementations (ethers/eth-rpc, PAPI/`revive.call`), default to ethers, flip per
build. `connect("injected")` gains a substrate branch reading `injectedWeb3` from
the Polkadot App's dApp browser alongside the existing `window.ethereum` branch.

Events are the other half: `eth_getLogs` becomes `revive::ContractEmitted`
filtering, which — usefully — has none of the topic-placeholder limitation the
current client works around.

**Out of scope:** `venue-node/relay.mjs`, `scripts/`, the hardhat suite and the
ops console are ethers end-to-end and keep working against the gateway.

## See also
- [NETWORK-ARCHITECTURE.md](NETWORK-ARCHITECTURE.md) — the node-picker tiers this changes
- [RELAY-SPONSORSHIP.md](RELAY-SPONSORSHIP.md) — where the mapping deposit belongs
- [ARCHITECTURE.md](ARCHITECTURE.md) — the EIP-712 surface that stays secp256k1
