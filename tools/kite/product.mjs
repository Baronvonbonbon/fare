// The one place the published identity is written down.
//
// The label is deliberately random. A .dot address is public, and a readable
// one (fareprobe.dot, kite.dot) announces what is being tested and for whom
// before any answer is in. This says nothing.
//
// PRODUCT_ID must equal the DotNS label: the host derives product accounts and
// the local-storage namespace from it, and `hasBulletinAllowance` /
// `hasStatementStoreAllowance` are looked up per product. If these two drift
// apart, the allowance probe silently checks an identity that never published
// anything and reports a confident "no".
//
// Regenerate with:
//   python3 -c "import secrets,string;print(''.join(secrets.choice(string.ascii_lowercase) for _ in range(32)))"

export const PRODUCT_ID = "gutrfgfyuejtoijvywrcxjqyfwixipuk";
export const DOT_NAME = `${PRODUCT_ID}.dot`;
