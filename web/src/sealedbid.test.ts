import { describe, it, expect } from "vitest";
import { Wallet, AbiCoder, keccak256, hexlify, randomBytes } from "ethers";
import { pubKeyOf, sealAnon, openAnon } from "./msg";

// Sealed bids, client side (privacy phase 4).

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();

const { bidHashOf, revokeHashOf } = await import("./sealedbid");

const abi = AbiCoder.defaultAbiCoder();
const ORDER = 42n;

describe("bid hashing", () => {
  it("matches the contract's bidHashOf", () => {
    // Solidity: keccak256(abi.encode(orderId, driver, amount, salt)). If these
    // ever diverge, every sealed bid becomes unacceptable.
    const driver = Wallet.createRandom().address;
    const amount = 700000000000000000n;
    const salt = hexlify(randomBytes(32));
    const expected = keccak256(
      abi.encode(["uint256", "address", "uint96", "bytes32"], [ORDER, driver, amount, salt])
    );
    expect(bidHashOf(ORDER, driver, amount, salt)).toBe(expected);
  });

  it("binds the driver and the amount, so neither can be swapped", () => {
    const a = Wallet.createRandom().address;
    const b = Wallet.createRandom().address;
    const salt = hexlify(randomBytes(32));
    expect(bidHashOf(ORDER, a, 100n, salt)).not.toBe(bidHashOf(ORDER, b, 100n, salt));
    expect(bidHashOf(ORDER, a, 100n, salt)).not.toBe(bidHashOf(ORDER, a, 101n, salt));
    expect(bidHashOf(ORDER, a, 100n, salt)).not.toBe(bidHashOf(41n, a, 100n, salt));
  });

  it("hides the bid: the same terms under a fresh salt look unrelated", () => {
    const driver = Wallet.createRandom().address;
    const one = bidHashOf(ORDER, driver, 100n, hexlify(randomBytes(32)));
    const two = bidHashOf(ORDER, driver, 100n, hexlify(randomBytes(32)));
    expect(one).not.toBe(two);
  });

  it("revoke hash matches the contract's keccak256(abi.encode(secret))", () => {
    const secret = hexlify(randomBytes(32));
    expect(revokeHashOf(secret)).toBe(keccak256(abi.encode(["bytes32"], [secret])));
  });
});

describe("sealing bid terms to the customer", () => {
  const customer = Wallet.createRandom();
  const driver = Wallet.createRandom();
  const relay = Wallet.createRandom(); // stands in for a curious relay operator
  const ctx = `fare-bid:v1:${ORDER}`;

  const terms = () => JSON.stringify({ driver: driver.address, amount: "700", salt: hexlify(randomBytes(32)) });

  it("only the customer can read a bid", async () => {
    const sealed = await sealAnon(pubKeyOf(customer.privateKey), ctx, terms());
    const opened = JSON.parse(await openAnon(customer.privateKey, ctx, sealed));
    expect(opened.driver).toBe(driver.address);

    await expect(openAnon(relay.privateKey, ctx, sealed)).rejects.toThrow();
  });

  it("the envelope does not identify the bidder", async () => {
    // The relay stores this. If the driver's key were the sealing key, the relay
    // would learn the bid graph the on-chain commitment exists to hide.
    const sealed = await sealAnon(pubKeyOf(customer.privateKey), ctx, terms());
    const blob = (sealed.epk + sealed.iv + sealed.ct).toLowerCase();
    expect(blob).not.toContain(driver.address.slice(2).toLowerCase());
    expect(sealed.epk).not.toBe(pubKeyOf(driver.privateKey));
  });

  it("uses a fresh ephemeral key each time, so two bids do not link", async () => {
    const a = await sealAnon(pubKeyOf(customer.privateKey), ctx, terms());
    const b = await sealAnon(pubKeyOf(customer.privateKey), ctx, terms());
    expect(a.epk).not.toBe(b.epk);
  });

  it("does not open under a different order's context", async () => {
    const sealed = await sealAnon(pubKeyOf(customer.privateKey), ctx, terms());
    await expect(openAnon(customer.privateKey, `fare-bid:v1:43`, sealed)).rejects.toThrow();
  });

  it("rejects tampered ciphertext", async () => {
    const sealed = await sealAnon(pubKeyOf(customer.privateKey), ctx, terms());
    const flipped = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith("00") ? "01" : "00") };
    await expect(openAnon(customer.privateKey, ctx, flipped)).rejects.toThrow();
  });
});
