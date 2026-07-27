#!/usr/bin/env bash
# Mythril over the money-handling contracts (TEST-PLAN C6, run by E3's nightly).
#
# Slither is the per-PR gate — fast, deterministic, zero high-severity findings
# (docs/SECURITY-REVIEW.md). This is the deep pass it cannot afford: symbolic
# execution, minutes to tens of minutes per contract.
#
# ── Why this REPORTS rather than GATES ───────────────────────────────────────
#
# Mythril's output is a function of its exploration budget. Measured while
# wiring this up: at --execution-timeout 240 all three contracts come back
# clean; at 300 FareVault additionally reports SWC-116 (block.timestamp control
# flow) inside withdrawFor — which is the EIP-712 deadline doing exactly what a
# deadline does, and which Mythril itself notes is compiler-generated code.
#
# So a strict pass/fail on "any finding" would be red or green depending on how
# much CPU the runner happened to give it, and the first few false alarms would
# get the job muted. Instead: HIGH severity fails the job, everything else is
# reported and uploaded. The reports are the deliverable.
#
# Usage:  ./scripts/mythril.sh [contract ...]
# Env:    MYTH_TIMEOUT (per-contract execution budget, seconds; default 300)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="$ROOT/mythril-out"
TIMEOUT="${MYTH_TIMEOUT:-300}"
TARGETS=("$@")
if [ ${#TARGETS[@]} -eq 0 ]; then
  # The three that hold or move value. FareVault custodies balances,
  # FareOrders holds escrow, FareForwarder executes on behalf of a signer.
  TARGETS=(FareVault FareOrders FareForwarder)
fi

mkdir -p "$OUT"

# These settings must match hardhat.config.ts. viaIR and cancun are not
# optional niceties: OpenZeppelin's Bytes.sol uses `mcopy`, so a default
# evmVersion fails to COMPILE with "Function mcopy not found" — an error that
# looks like a broken install rather than a settings mismatch.
cat > "$OUT/solc-settings.json" <<'JSON'
{
  "remappings": ["@openzeppelin/=node_modules/@openzeppelin/"],
  "optimizer": { "enabled": true, "runs": 200 },
  "viaIR": true,
  "evmVersion": "cancun"
}
JSON

echo "mythril $(myth version 2>/dev/null | tail -1) — budget ${TIMEOUT}s/contract"
echo

high_total=0
issue_total=0
failed_runs=()

for c in "${TARGETS[@]}"; do
  echo "── $c ──"
  # Mythril exits non-zero when it finds anything, so its status cannot
  # distinguish "found an issue" from "crashed". The JSON's `success` field can.
  myth analyze "contracts/$c.sol" \
    --solc-json "$OUT/solc-settings.json" \
    --solv 0.8.24 \
    --execution-timeout "$TIMEOUT" \
    -o json > "$OUT/$c.json" 2> "$OUT/$c.stderr" || true

  myth analyze "contracts/$c.sol" \
    --solc-json "$OUT/solc-settings.json" \
    --solv 0.8.24 \
    --execution-timeout "$TIMEOUT" \
    -o markdown > "$OUT/$c.md" 2>/dev/null || true

  if ! node -e "JSON.parse(require('fs').readFileSync('$OUT/$c.json','utf8'))" 2>/dev/null; then
    echo "   ✗ produced no parseable report — see $OUT/$c.stderr"
    tail -5 "$OUT/$c.stderr" | sed 's/^/     /'
    failed_runs+=("$c")
    continue
  fi

  read -r ok n high <<<"$(node -e "
    const d = JSON.parse(require('fs').readFileSync('$OUT/$c.json','utf8'));
    const issues = d.issues ?? [];
    const high = issues.filter(i => String(i.severity).toLowerCase() === 'high').length;
    console.log([d.success ? 1 : 0, issues.length, high].join(' '));
  ")"

  if [ "$ok" != "1" ]; then
    echo "   ✗ analysis did not complete (see $OUT/$c.json)"
    failed_runs+=("$c")
    continue
  fi

  issue_total=$((issue_total + n))
  high_total=$((high_total + high))
  if [ "$n" -eq 0 ]; then
    echo "   ✓ no issues"
  else
    echo "   $n issue(s), $high high:"
    node -e "
      const d = JSON.parse(require('fs').readFileSync('$OUT/$c.json','utf8'));
      for (const i of d.issues ?? []) console.log('     ' + [i['swc-id'], i.severity, i.function, i.title].join(' | '));
    "
  fi
done

echo
echo "── summary: $issue_total issue(s), $high_total high, ${#failed_runs[@]} run(s) failed to complete ──"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Mythril"
    echo
    echo "Budget: \`${TIMEOUT}s\` per contract. **Findings scale with this budget** — see \`scripts/mythril.sh\`."
    echo
    echo "| Contract | Issues | High | Completed |"
    echo "|---|---|---|---|"
    for c in "${TARGETS[@]}"; do
      if [ -s "$OUT/$c.json" ] && node -e "JSON.parse(require('fs').readFileSync('$OUT/$c.json','utf8'))" 2>/dev/null; then
        node -e "
          const d = JSON.parse(require('fs').readFileSync('$OUT/$c.json','utf8'));
          const is = d.issues ?? [];
          const high = is.filter(i => String(i.severity).toLowerCase() === 'high').length;
          console.log(['| $c', is.length, high, d.success ? 'yes' : 'no'].join(' | ') + ' |');
        "
      else
        echo "| $c | – | – | no |"
      fi
    done
    echo
    echo "Full reports are in the \`mythril-reports\` artifact."
  } >> "$GITHUB_STEP_SUMMARY"
fi

# Only HIGH fails the build. A run that could not complete is reported loudly
# but does not fail it either: an infrastructure timeout is not a finding, and
# treating it as one is how a nightly gets ignored.
if [ "$high_total" -gt 0 ]; then
  echo "::error::mythril reported $high_total high-severity issue(s)"
  exit 1
fi
# A run that could not finish is normally infrastructure, not a finding, so it
# warns. But if NOTHING completed, the job analysed nothing at all — and a green
# check that analysed nothing is worse than a red one. The first nightly did
# exactly that: solc was unreachable, all three died in seconds, and it passed.
if [ ${#failed_runs[@]} -eq ${#TARGETS[@]} ]; then
  echo "::error::mythril analysed NOTHING — every target failed to complete (${failed_runs[*]})"
  exit 1
fi
if [ ${#failed_runs[@]} -ne 0 ]; then
  echo "::warning::mythril could not complete: ${failed_runs[*]}"
fi
exit 0
