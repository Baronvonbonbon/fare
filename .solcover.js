// solidity-coverage config (TEST-PLAN E2).
//
// Run: NODE_OPTIONS=--max-old-space-size=6144 npx hardhat coverage
//
// The heap flag is not optional. Instrumentation rewrites every contract to
// emit a marker per branch, and the full suite — which spins up HTTP bridges
// and builds real Groth16 proofs — then exceeds node's 2 GB default and dies
// with "Reached heap limit" partway through the report.
module.exports = {
  // json-summary is what scripts/ci/coverage-floor.mjs reads; the rest are for
  // a human looking at a failure.
  istanbulReporter: ["text", "json-summary", "lcov", "html"],

  // Test doubles, not product code. They exist to make the real contracts
  // testable, so counting them measures the scaffolding rather than the thing —
  // and a mock's unused branch would read as a coverage regression.
  skipFiles: ["mocks/"],

  // `configureYulOptimizer` is needed because hardhat.config.ts compiles with
  // viaIR: without it, instrumented contracts hit "stack too deep" that the
  // uninstrumented build does not.
  configureYulOptimizer: true,
};
