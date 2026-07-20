// Cloudflare Pages Function — POST /api/drip
//
// Burner-wallet gas faucet for the demo/pilot. The drip key lives ONLY as a
// server-side secret (DRIP_PRIVATE_KEY), never in the browser bundle, so the
// hosted PWA can auto-fund a fresh burner without exposing a signer to the
// public. This substitutes for the roadmap's R2 gasless relay on testnet.
//
// Abuse bound: funding is balance-gated (an address already above MIN is never
// funded), and the drip account holds a small, capped balance — worst case an
// attacker drains that cap and the operator refills. Testnet money only.
//
// Secret setup (production): Cloudflare Pages -> Settings -> Environment
// variables -> add DRIP_PRIVATE_KEY (encrypted). Local dev: web/.dev.vars.
import { JsonRpcProvider, Wallet, formatEther, isAddress, parseEther } from "ethers";

interface Env {
  DRIP_PRIVATE_KEY?: string;
  TESTNET_RPC?: string;
  DRIP_AMOUNT_PAS?: string; // top-up size (default 5)
  DRIP_MIN_PAS?: string; // only fund addresses below this (default 2)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const onRequestPost = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => {
  const { request, env } = context;

  if (!env.DRIP_PRIVATE_KEY) {
    // Not configured yet — tell the client so it can fall back to the faucet.
    return json({ error: "drip not configured", configured: false }, 503);
  }

  let address: string;
  try {
    const body = (await request.json()) as { address?: string };
    address = String(body.address ?? "");
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!isAddress(address)) return json({ error: "invalid address" }, 400);

  const rpc = env.TESTNET_RPC || "https://eth-rpc-testnet.polkadot.io/";
  const amount = parseEther(env.DRIP_AMOUNT_PAS || "5");
  const min = parseEther(env.DRIP_MIN_PAS || "2");

  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });

  try {
    const balance = await provider.getBalance(address);
    if (balance >= min) {
      return json({ funded: false, reason: "sufficient", balance: formatEther(balance) });
    }

    const drip = new Wallet(env.DRIP_PRIVATE_KEY, provider);
    const dripBal = await provider.getBalance(drip.address);
    if (dripBal < amount) {
      return json({ error: "drip account empty — ask the operator to refill" }, 503);
    }

    // Paseo quirks:
    //  - explicit nonce via getTransactionCount (default "latest"): ethers'
    //    auto-populate uses the "pending" tag, which the eth-rpc rejects and
    //    surfaces to ethers as "could not coalesce error";
    //  - modest gasLimit: a plain transfer really uses ~11k gas, and the pool
    //    validity check reserves gasLimit * maxFeePerGas up front — deploy.ts's
    //    500M limit would reserve ~1000 PAS and get the (small) drip account
    //    rejected as unable to pay. 100k keeps the reservation ~0.2 PAS;
    //  - whole-PAS value keeps clear of the `value % 1e6 >= 5e5` rejection.
    const nonce = await provider.getTransactionCount(drip.address);
    const tx = await drip.sendTransaction({
      to: address,
      value: amount,
      nonce,
      gasLimit: 100_000n,
    });
    return json({ funded: true, txHash: tx.hash, amount: formatEther(amount) });
  } catch (e: any) {
    return json({ error: e?.shortMessage ?? e?.message ?? String(e) }, 500);
  }
};
