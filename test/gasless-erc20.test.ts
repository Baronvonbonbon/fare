import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Option C — GASLESS stablecoin orders. createOrderERC20 / acceptBidERC20 read
// _msgSender() (their escrow is a transferFrom from the customer's own balance,
// so a forwarding relay never fronts value), and createOrderERC20WithPermit
// carries an EIP-2612 permit so there's no separate approve. A customer with
// ZERO native balance can place and fund an order entirely by signatures; the
// relay pays all the gas.
const VENUE_LAT = 37_774_900, VENUE_LON = -122_419_400;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const ORDER_VALUE = USDC(10), TIP = USDC(1), MAX_FARE = USDC(5), FARE = USDC(4);
const commit = "0x" + "ab".repeat(32);

describe("FARE — gasless stablecoin orders (Option C)", () => {
  async function deploy() {
    const [deployer, treasury, driverS, venueOp, venueSigner, relay] = await ethers.getSigners();
    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);
    await orders.setAcceptedToken(usdc.target, true);
    await drivers.connect(driverS).register("ipfs://d", { value: ethers.parseEther("1") });
    await venues.connect(venueOp).registerVenue(VENUE_LAT, VENUE_LON, venueSigner.address, venueOp.address, "ipfs://v");
    const chainId = (await ethers.provider.getNetwork()).chainId;

    // A brand-new customer wallet with USDC but ZERO native balance.
    const customer = ethers.Wallet.createRandom().connect(ethers.provider);
    await usdc.mint(customer.address, USDC(1000));
    return { deployer, treasury, driverS, venueOp, venueSigner, relay, orders, usdc, forwarder, vault, drivers, venueId: 1n, chainId, customer };
  }

  // EIP-2612 permit signature (owner → spender, value).
  async function signPermit(usdc: any, owner: any, spender: string, value: bigint, chainId: bigint) {
    const deadline = BigInt((await time.latest()) + 3600);
    const nonce = await usdc.nonces(owner.address);
    const sig = await owner.signTypedData(
      { name: "Mock USD Coin", version: "1", chainId, verifyingContract: usdc.target },
      { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" },
        { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] },
      { owner: owner.address, spender, value, nonce, deadline }
    );
    const { v, r, s } = ethers.Signature.from(sig);
    return { v, r, s, deadline, value };
  }

  // Sign an OZ ERC2771Forwarder ForwardRequest wrapping `data` to `orders`.
  async function signForward(forwarder: any, signer: any, to: string, data: string, chainId: bigint) {
    const nonce = await forwarder.nonces(signer.address);
    const deadline = BigInt((await time.latest()) + 3600);
    const gas = 2_000_000n;
    const req = { from: signer.address, to, value: 0n, gas, nonce, deadline, data };
    const signature = await signer.signTypedData(
      { name: "FareForwarder", version: "1", chainId, verifyingContract: forwarder.target },
      { ForwardRequest: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint48" }, { name: "data", type: "bytes" },
      ] }, req
    );
    return { from: req.from, to: req.to, value: req.value, gas: req.gas, deadline: req.deadline, data, signature };
  }

  it("a zero-gas customer places + funds a token order via permit + forwarder", async () => {
    const f = await loadFixture(deploy);
    expect(await ethers.provider.getBalance(f.customer.address)).to.equal(0n); // no native at all

    // permit for the full escrow (MaxUint256 so it also covers the later accept)
    const p = await signPermit(f.usdc, f.customer, f.orders.target as string, ethers.MaxUint256, f.chainId);
    const data = f.orders.interface.encodeFunctionData("createOrderERC20WithPermit", [
      f.usdc.target, f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0, p.value, p.deadline, p.v, p.r, p.s,
    ]);
    const req = await signForward(f.forwarder, f.customer, f.orders.target as string, data, f.chainId);

    const relayBefore = await ethers.provider.getBalance(f.relay.address);
    await f.forwarder.connect(f.relay).execute(req); // RELAY pays gas
    expect(await ethers.provider.getBalance(f.relay.address)).to.be.lt(relayBefore); // relay spent gas
    expect(await ethers.provider.getBalance(f.customer.address)).to.equal(0n);       // customer paid none

    const o = await f.orders.orders(1n);
    expect(o.customer).to.equal(f.customer.address);      // customer = the signer, NOT the forwarder
    expect(o.token).to.equal(f.usdc.target);
    expect(await f.usdc.balanceOf(f.orders.target)).to.equal(ORDER_VALUE + TIP); // escrow pulled from customer
    expect(await f.usdc.balanceOf(f.customer.address)).to.equal(USDC(1000) - ORDER_VALUE - TIP);
  });

  it("acceptBidERC20 is gaslessly forwardable (relay pays, escrow from customer)", async () => {
    const f = await loadFixture(deploy);
    // create (gasless) with a MaxUint256 permit so accept needs no further approve
    const p = await signPermit(f.usdc, f.customer, f.orders.target as string, ethers.MaxUint256, f.chainId);
    const cData = f.orders.interface.encodeFunctionData("createOrderERC20WithPermit", [
      f.usdc.target, f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0, p.value, p.deadline, p.v, p.r, p.s]);
    await f.forwarder.connect(f.relay).execute(await signForward(f.forwarder, f.customer, f.orders.target as string, cData, f.chainId));

    await f.orders.connect(f.driverS).placeBid(1n, FARE);

    // accept, forwarded (customer still zero-gas)
    const aData = f.orders.interface.encodeFunctionData("acceptBidERC20", [1n, f.driverS.address]);
    await f.forwarder.connect(f.relay).execute(await signForward(f.forwarder, f.customer, f.orders.target as string, aData, f.chainId));

    const o = await f.orders.orders(1n);
    expect(o.status).to.equal(2n); // Assigned
    expect(o.driver).to.equal(f.driverS.address);
    expect(o.fare).to.equal(FARE);
    expect(await f.usdc.balanceOf(f.orders.target)).to.equal(ORDER_VALUE + TIP + FARE);
    expect(await ethers.provider.getBalance(f.customer.address)).to.equal(0n);
  });

  it("plain createOrderERC20 (no permit) is forwardable and records _msgSender as customer", async () => {
    const f = await loadFixture(deploy);
    // pre-permit the allowance in one signed call is not available without the WithPermit path,
    // so approve via a forwarded... instead: prove _msgSender identity with a normal (funded) approve.
    // Here the customer has zero gas, so use the WithPermit-set allowance path indirectly:
    // sign a permit directly to establish allowance, then forward the plain createOrderERC20.
    const p = await signPermit(f.usdc, f.customer, f.orders.target as string, ethers.MaxUint256, f.chainId);
    await f.usdc.permit(f.customer.address, f.orders.target, p.value, p.deadline, p.v, p.r, p.s); // anyone can submit a permit
    const data = f.orders.interface.encodeFunctionData("createOrderERC20", [f.usdc.target, f.venueId, commit, ORDER_VALUE, TIP, MAX_FARE, 0, 0]);
    await f.forwarder.connect(f.relay).execute(await signForward(f.forwarder, f.customer, f.orders.target as string, data, f.chainId));
    const o = await f.orders.orders(1n);
    expect(o.customer).to.equal(f.customer.address); // forwarded sender, not the forwarder/relay
  });

  it("native createOrder still uses msg.sender (not forwardable for value)", async () => {
    const f = await loadFixture(deploy);
    // a forwarded native createOrder would set customer = forwarder and carry no value → reverts on bad-value
    const data = f.orders.interface.encodeFunctionData("createOrder", [f.venueId, commit, 0, 0, MAX_FARE, 0, 0]);
    // forwarder sends value:0; createOrder requires msg.value == orderValue+tip == 0, so it would pass value-wise,
    // but the customer would be the FORWARDER — proving native path ignores the appended sender.
    await f.forwarder.connect(f.relay).execute(await signForward(f.forwarder, f.customer, f.orders.target as string, data, f.chainId));
    const o = await f.orders.orders(1n);
    expect(o.customer).to.equal(f.forwarder.target); // native reads msg.sender = forwarder, NOT the signer
    expect(o.customer).to.not.equal(f.customer.address);
  });
});
