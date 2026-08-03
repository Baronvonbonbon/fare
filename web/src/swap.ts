// Sourcing USDC: swap PAS on Asset Hub's own asset-conversion DEX.
//
// WHERE THIS SITS IN THE FLOW, and why it matters:
//
//   funded account ──swap──> USDC ──shield──> [KS pool] ──withdraw──> burner
//                    ^^^^                     ^^^^^^^^^^^^^^^^^^
//                  THIS FILE                 anonymity boundary
//
// The swap is PRE-SHIELD and deliberately public. It happens on the customer's
// own funded account, on the funder's side of the boundary — the same kind of
// visible event as a withdrawal from an exchange, and it reveals nothing about
// any order.
//
// The alternative — shield PAS, then swap at the burner — is what an earlier
// design did, and it is worse. A burner making a distinctive-amount DEX swap
// correlates by amount and timing with its own funding deposit, handing an
// observer exactly the link the burner exists to break. Never swap at a burner
// except to recover from holding the wrong asset.
//
// The relay only BUILDS the call. It never holds or moves the funds: it hands
// back unsigned calldata and the customer's own wallet signs and sends it. A
// relay that swapped on the user's behalf would learn the PAS→USDC mapping per
// user, which is the same link by a different route.
import { Contract, Interface, type Signer } from "ethers";
import { activeRelayUrl } from "./relay";
import { readProvider } from "./chain";
import { SWAP_GAS } from "./gasbudget";

/// There is NO asset-conversion precompile — a scan of the space finds code at
/// only the XCM precompile and 0x…0900. The XCM precompile's `ExchangeAsset`,
/// executed locally under the caller's own origin, is the route that works.
export const XCM_PRECOMPILE = "0x00000000000000000000000000000000000a0000";

const XCM_ABI = [
  "function weighMessage(bytes message) view returns (uint64 refTime, uint64 proofSize)",
  // Weight is a STRUCT. Passing a bare uint64 encodes wrong and reverts as
  // OUT_OF_MEMORY — a decode failure wearing a very misleading name.
  "function execute(bytes message, (uint64 refTime, uint64 proofSize) weight)",
];

export interface SwapPlan {
  to: string;
  xcm: string;
  assetId: number;
  want: bigint;
  quotedPas: bigint;
  givePas: bigint;
  slippageBps: bigint;
}

/// Ask the relay to quote and encode a swap for exactly `want` smallest-units of
/// `token`, deposited back to `from`. Returns null if no relay is reachable or
/// the pool has no liquidity — callers must disable the swap UI, not guess.
export async function planSwap(
  token: string, want: bigint, from: string, slippageBps = 500n
): Promise<SwapPlan | null> {
  const relay = activeRelayUrl();
  if (!relay) return null;
  try {
    const res = await fetch(
      `${relay}/swap-xcm?token=${token}&want=${want}&from=${from}&slippageBps=${slippageBps}`
    );
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.xcm || !j?.to) return null;
    return {
      to: j.to, xcm: j.xcm, assetId: j.assetId,
      want: BigInt(j.want), quotedPas: BigInt(j.quotedPas),
      givePas: BigInt(j.givePas), slippageBps: BigInt(j.slippageBps),
    };
  } catch {
    return null; // fail closed
  }
}

/// Execute a plan from the customer's own funded account.
///
/// Weighs and SIMULATES before sending. Both are free eth_calls, and the
/// simulation is what surfaces "no liquidity" or a malformed message as an error
/// instead of a burnt-gas revert.
export async function executeSwap(
  signer: Signer, plan: SwapPlan, gasLimit = SWAP_GAS
): Promise<{ txHash: string }> {
  const iface = new Interface(XCM_ABI);
  const provider = readProvider as any;
  const from = await signer.getAddress();

  const weighed = iface.decodeFunctionResult(
    "weighMessage",
    await provider.call({ to: plan.to, data: iface.encodeFunctionData("weighMessage", [plan.xcm]) })
  );
  const data = iface.encodeFunctionData("execute", [plan.xcm, [weighed[0], weighed[1]]]);

  await provider.call({ to: plan.to, data, from }); // throws here if it would revert

  const tx = await signer.sendTransaction({ to: plan.to, data, gasLimit });
  await tx.wait();
  return { txHash: tx.hash };
}

/// Swap only what is missing. `have` and `need` are smallest-units of `token`;
/// returns null when the balance already covers it, so the caller can skip the
/// swap entirely rather than emitting a zero-value one.
export async function swapForShortfall(
  signer: Signer, token: string, have: bigint, need: bigint, slippageBps = 500n
): Promise<{ txHash: string; bought: bigint } | null> {
  if (have >= need) return null;
  const want = need - have;
  const from = await signer.getAddress();
  const plan = await planSwap(token, want, from, slippageBps);
  if (!plan) throw new Error("no swap route — relay unreachable or the pool has no liquidity");
  const { txHash } = await executeSwap(signer, plan);
  return { txHash, bought: want };
}

/// Is the swap path usable at all? Gated on a relay, since the XCM builder lives
/// there. Without one a user must already hold USDC.
export const swapAvailable = (): boolean => !!activeRelayUrl();

/// Read an Asset Hub asset balance through its ERC-20 precompile view.
export async function tokenBalance(token: string, account: string): Promise<bigint> {
  const erc = new Contract(token, ["function balanceOf(address) view returns (uint256)"], readProvider as any);
  return await erc.balanceOf(account);
}
