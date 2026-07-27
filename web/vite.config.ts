import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  // Two apps from one project: the consumer PWA (index.html) and the ops /
  // governance console (ops/index.html → served at a clean /ops), which shares
  // the chain glue but has no shared nav and no service worker. Emitting the ops
  // entry as ops/index.html (rather than ops.html) gives a directory-index route,
  // so /ops resolves on Cloudflare Pages / any static host without relying on
  // .html-extension stripping. See src/ops/.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        ops: fileURLToPath(new URL("./ops/index.html", import.meta.url)),
      },
    },
  },
  resolve: {
    alias: {
      // pine-rpc's root entry also exports its node-only JsonRpcServer
      // (node:http, ws), which rollup can't bundle for the browser. The app
      // only needs PineProvider, so alias the package to that module — its
      // dependency graph is browser-clean (verified: no node builtins
      // outside src/server and src/cli).
      "pine-rpc": fileURLToPath(
        new URL("./node_modules/pine-rpc/dist/PineProvider.js", import.meta.url)
      ),
    },
  },
  // pine-rpc dynamically imports smoldot (WASM light client); keep both out
  // of dep prebundling and let the dynamic import create its own chunk so
  // the main bundle stays light for users who never pick the embedded node.
  optimizeDeps: { exclude: ["pine-rpc", "smoldot"] },

  // ── Coverage (TEST-PLAN E2) ────────────────────────────────────────────────
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],

      // `include` is the load-bearing line. By default v8 reports only files a
      // test actually imported, which would leave App.tsx — 2,689 lines with no
      // tests — out of the denominator entirely, so the percentage would RISE
      // when someone added untested code. Naming the sources instead makes an
      // untested file count as the zero it is.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/main.tsx",     // mounts React; nothing to assert
        "src/**/*.d.ts",
      ],

      // Floors are what the suite measures TODAY, rounded down — they exist to
      // stop the number sliding, not to describe an ambition. The figures are
      // low because they are honest: App.tsx (2,689 lines), the four console
      // components and seven client-core modules are all counted at the zero
      // they are (TEST-PLAN §6 D1/D2). Raise these when work lands; never lower
      // one to make a build pass — a ratchet that turns both ways is a comment.
      // Raised twice with D2: 17.40 → 20.19 (wallets, zk, token, chain glue)
      // → 22.25 (relay, router resolution). `App.tsx` and the four console
      // components are still in here at zero, which is what keeps the absolute
      // number low — see §6 D1.
      thresholds: {
        statements: 22,
        branches: 14,
        functions: 19,
        lines: 23,
      },
    },
  },
});
