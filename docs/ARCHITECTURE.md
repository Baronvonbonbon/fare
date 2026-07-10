# FARE Architecture

Seven small contracts, one money-out path, two dual-signed checkpoints.
Deliberately a fraction of DATUM alpha-core's surface — the protocol earns
complexity only when volume demands it (see ROADMAP.md).

## Contract map

```
                 ┌────────────────┐
      customer ─►│   FareOrders   │◄─ drivers (bids)
                 │ escrow+auction │
                 │  lifecycle     │──credit──► FareVault ◄─ withdraw (pull)
                 └───┬───────▲────┘             ▲
   onPickupConfirmed│        │markDisputed      │credit (bond)
   onDropoffConfirmd│        │resolveDisputed   │
                 ┌───▼────┐ ┌─┴───────────┐     │
                 │  Fare  │ │ FareDisputes│─────┘
                 │Settlem.│ │  (arbiter)  │──slash──► FareDrivers
                 └───┬────┘ └─────────────┘
        EIP-712 sigs │ geo checks
                 ┌───▼────────┐   ┌─────────────┐   ┌──────────────────┐
                 │ FareVenues │   │ FareDrivers │   │FarePauseRegistry │
                 │ pins+signer│   │ stake+rep   │   │  4 categories    │
                 └────────────┘   └─────────────┘   └──────────────────┘
```

- **FareOrders** owns all escrow. Every state transition that moves money is
  either customer-initiated (create/accept/tip/cancel), settlement-gated
  (`onlySettlement` callbacks), or dispute-gated (`onlyDisputes`).
  A per-order `escrow` field tracks conservation: it only decreases by
  exactly what is credited out.
- **FareSettlement** holds zero funds. It verifies signatures + geometry and
  calls back into Orders. Anyone can submit a confirmation (both signatures
  are required anyway) — this keeps the path open for gasless relays later.
- **FareVault** is the single sink/source for payouts. `credit{value}` from
  authorized contracts, `withdraw()` by recipients. Inherits
  `PaseoSafeSender` so the Paseo denomination bug can't strand a payout.
- **FareDisputes** freezes an order (`Disputed`), then executes the
  arbiter's ruling: escrow split (bps), optional driver stake slash paid to
  the customer, bond refund/forfeit.

## Order lifecycle

```
        createOrder            acceptBid              confirmPickup      confirmDropoff
 (none) ───────────► Open ────────────────► Assigned ───────────► PickedUp ─────────► Delivered
                      │ cancelOpen             │ cancelAssigned / abandonOrder │
                      ▼                        ▼                               │
                  Cancelled                Cancelled                           │
                                               │ openDispute                   │ openDispute
                                               ▼                               ▼
                                           Disputed ──resolve──► Resolved
```

Cancellation economics:

| Path | Refund | Driver gets | Reputation |
|---|---|---|---|
| `cancelOpen` | 100% | — | — |
| `cancelAssigned` before pickup deadline | escrow − comp | `assignedCancelBps` of fare (default 20%) | — |
| `cancelAssigned` after deadline (no-show) | 100% | 0 | driver `failed++` |
| `abandonOrder` (driver) | 100% | 0 | driver `failed++` |
| `PickedUp` + overdue | no unilateral path — goods are with the driver; dispute only | arbiter ruling | arbiter ruling |

## EIP-712 surface

Domain: `FareSettlement` / `1` / chainId / settlement address.

```
LocationAttestation(uint256 orderId, uint8 phase, address actor,
                    int32 lat, int32 lon, uint64 timestamp)
DropoffReveal(uint256 orderId, int32 lat, int32 lon,
              uint256 salt, uint64 timestamp)
```

- `phase` (1 = pickup, 2 = dropoff) prevents cross-phase replay.
- `actor` binds the signature to the expected party (driver / venue signer),
  checked against the order and the venue registry at verification time.
- Replay across submissions is prevented by the order-status gate (each
  phase transition fires once).
- Venue signing uses a **hot signer key** (`FareVenues.signerOf`) — the
  counter tablet key — distinct from the operator (cold) and payout
  addresses. Same key-role separation as DATUM's `relaySigner` pattern.

## Paseo operational notes (inherited from DATUM)

- **Denomination bug**: eth-rpc rejects `value % 10^6 >= 500_000`.
  `PaseoSafeSender._safeSend` rounds down and queues the dust per-recipient.
- **Null receipts**: `getTransactionReceipt` can return null for confirmed
  txs. `scripts/deploy.ts` confirms by nonce polling and derives addresses
  with `getCreateAddress`, verifying with `getCode`.
- **Gas**: weight-unit scale on Paseo; deploy script pins
  `gasLimit: 500_000_000` there and lets local nodes estimate.
- **EIP-170**: all seven contracts are far under 24,576 B runtime — no
  delegatecall splits needed at this scope.

## Access-control summary

| Surface | Who |
|---|---|
| `FareOrders.configure/setParams` | owner (deployer → multisig) |
| Settlement callbacks on Orders | `onlySettlement` |
| Dispute hooks on Orders | `onlyDisputes` |
| `FareVault.credit` | authorized contracts (orders, disputes) |
| `FareDrivers.slash/record*` | authorized contracts (orders, disputes) |
| `FareVenues.recordPickup` | authorized (orders) |
| `FareDisputes.resolve` | `arbiter` (swappable, → council later) |
| Pause | owner + guardians pause; owner unpauses |
| Exits (cancel, withdraw, unstake) | **never pause-gated** |
