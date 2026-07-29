// Point FARE's stablecoin escrow at REAL Asset Hub USDC (asset 1337, seen from
// the EVM through its ERC-20 precompile) and retire MockUSDC as the accepted
// token on the live deployment.
//
// MockUSDC was a 6-decimal ERC-20 with an OPEN `mint`, so "funding a customer"
// meant minting yourself money. It is not a real asset: it cannot be XCM'd, it
// has no market, and its price is whatever you say it is — which quietly makes
// the relay's profitability guard meaningless for token orders, because the
// guard values a token rebate at RELAY_TOKEN_PRICE.
//
// Real USDC has a live PAS pool on Asset Hub's own asset-conversion DEX, so a
// balance is sourced by SWAPPING (scripts/swap-local-dex.mjs), and the price the
// guard uses is a real one (treasury.assetConversionQuote).
//
// The one thing that is genuinely worse: the precompile is a bare IERC20 with no
// `permit()`, so gasless token orders must use the approve path rather than
// createOrderERC20WithPermit. That is a real regression in convenience and a
// deliberate trade for using an asset that actually exists.
//
// Usage: npx hardhat run scripts/accept-real-usdc.ts --network polkadotTestnet
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const PASEO = ["polkadotTestnet", "pine"].includes(network.name);
// A storage write, not a deploy: gasLimit x maxFeePerGas is reserved up front,
// so 500M would lock ~1000 PAS per call for no reason.
const GAS_LIMIT = PASEO ? 5_000_000n : undefined;
const suffix = PASEO ? "" : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_ADDR_FILE = path.join(__dirname, "..", "web", "src", "deployed-addresses.json");

// Asset Hub asset 1337 (USDC), as the EVM sees it: 4-byte asset id + the
// 0x01200000 precompile marker.
const REAL_USDC = process.env.STABLECOIN_ADDRESS ?? "0x0000053900000000000000000000000001200000";

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const book = JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  const orders = await ethers.getContractAt("FareOrders", book.orders, deployer);

  const erc = new ethers.Contract(REAL_USDC, [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
  ], provider);
  const [sym, dp, supply] = await Promise.all([erc.symbol(), erc.decimals(), erc.totalSupply()]);
  console.log(`orders     ${book.orders}`);
  console.log(`new token  ${REAL_USDC}  ${sym} ${dp}dp  supply ${Number(supply) / 10 ** Number(dp)}`);
  console.log(`old token  ${book.stablecoin} (MockUSDC — being retired)\n`);
  if (Number(dp) !== 6) throw new Error(`expected a 6-decimal token, got ${dp}`);

  // Carry the token service fee across from the old token, so the migration does
  // not silently zero what governance had set.
  const oldFee = await orders.relayServiceFee(book.stablecoin);
  console.log(`service fee on the old token: ${Number(oldFee) / 1e6} ${sym} — carrying it over`);

  async function send(label: string, fn: (nonce: number) => Promise<any>) {
    const nonce = await provider.getTransactionCount(deployer.address);
    await fn(nonce);
    for (let i = 0; i < 180; i++) {
      if ((await provider.getTransactionCount(deployer.address)) > nonce) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`  ~ ${label}`);
  }

  await send("orders.setAcceptedToken(realUSDC, true)", (n) =>
    orders.setAcceptedToken(REAL_USDC, true, { nonce: n, gasLimit: GAS_LIMIT })
  );
  await send("orders.setRelayServiceFee(realUSDC)", (n) =>
    orders.setRelayServiceFee(REAL_USDC, oldFee, { nonce: n, gasLimit: GAS_LIMIT })
  );
  // Retire the mock: refuse it as escrow so no new order can be opened against a
  // token anyone can print. In-flight mock orders still settle — acceptedToken is
  // only checked at creation.
  if (book.stablecoin && book.stablecoin !== REAL_USDC) {
    await send("orders.setAcceptedToken(mock, FALSE)", (n) =>
      orders.setAcceptedToken(book.stablecoin, false, { nonce: n, gasLimit: GAS_LIMIT })
    );
  }

  const checks: Array<[string, boolean]> = [
    ["real USDC accepted", await orders.acceptedToken(REAL_USDC)],
    ["mock no longer accepted", book.stablecoin === REAL_USDC || !(await orders.acceptedToken(book.stablecoin))],
    ["service fee carried over", (await orders.relayServiceFee(REAL_USDC)) === oldFee],
  ];
  for (const [n, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${n}`);
  if (!checks.every(([, ok]) => ok)) throw new Error("validation failed");

  const oldToken = book.stablecoin;
  book.stablecoin = REAL_USDC;
  fs.writeFileSync(ADDR_FILE, JSON.stringify(book, null, 2) + "\n");
  const webBook = {
    network: network.name,
    chainId: Number((await provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    addresses: book,
  };
  fs.writeFileSync(WEB_ADDR_FILE, JSON.stringify(webBook, null, 2) + "\n");
  console.log(`\nDone. stablecoin ${oldToken} → ${REAL_USDC}`);
  console.log(`Source a balance with: node scripts/swap-local-dex.mjs`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
