import { expect } from "chai";
import { ethers } from "hardhat";

// GeoLib fixed-point geodesy checks.
// Reference distances computed with the haversine formula off-chain;
// the on-chain equirectangular + Bhaskara-cosine approximation should land
// within a few percent at geofence scales.
describe("GeoLib", () => {
  async function deployHarness() {
    const Harness = await ethers.getContractFactory("GeoHarness");
    return Harness.deploy();
  }

  const DEG = 1_000_000; // microdegrees per degree

  it("cosine approximation matches known values", async () => {
    const h = await deployHarness();
    const COS_SCALE = 100_000n;

    // cos(0) = 1
    expect(await h.cosMicroDeg(0)).to.equal(COS_SCALE);

    // cos(60°) = 0.5 — Bhaskara error < 0.2%
    const cos60 = await h.cosMicroDeg(60 * DEG);
    expect(cos60).to.be.closeTo(50_000n, 200n);

    // cos(37.77°) ≈ 0.79052 (San Francisco latitude)
    const cosSF = await h.cosMicroDeg(37_774_900);
    expect(cosSF).to.be.closeTo(79_052n, 300n);

    // symmetric for negative latitudes
    expect(await h.cosMicroDeg(-60 * DEG)).to.equal(cos60);
  });

  it("distance: 0.001° of latitude ≈ 111.3 m", async () => {
    const h = await deployHarness();
    const d2 = await h.distanceSquaredMeters(37_774_900, -122_419_400, 37_775_900, -122_419_400);
    const d = Math.sqrt(Number(d2));
    expect(d).to.be.closeTo(111.3, 1.5);
  });

  it("distance: longitude shrinks with cos(lat)", async () => {
    const h = await deployHarness();
    // 0.001° of longitude at SF latitude ≈ 111.32 * cos(37.775°) ≈ 88.0 m
    const d2 = await h.distanceSquaredMeters(37_774_900, -122_419_400, 37_774_900, -122_418_400);
    const d = Math.sqrt(Number(d2));
    expect(d).to.be.closeTo(88.0, 1.5);
  });

  it("withinRadius boundary behavior", async () => {
    const h = await deployHarness();
    const lat = 37_774_900;
    const lon = -122_419_400;
    // ~111m north
    const north = lat + 1_000;
    expect(await h.withinRadius(lat, lon, north, lon, 150)).to.equal(true);
    expect(await h.withinRadius(lat, lon, north, lon, 100)).to.equal(false);
    // identical points always within
    expect(await h.withinRadius(lat, lon, lat, lon, 1)).to.equal(true);
  });

  it("rejects invalid coordinates", async () => {
    const h = await deployHarness();
    await expect(h.requireValid(90_000_001, 0)).to.be.revertedWithCustomError(
      { interface: h.interface },
      "GeoInvalidLatitude"
    );
    await expect(h.requireValid(0, -180_000_001)).to.be.revertedWithCustomError(
      { interface: h.interface },
      "GeoInvalidLongitude"
    );
    await h.requireValid(90_000_000, 180_000_000); // extremes are valid
  });
});
