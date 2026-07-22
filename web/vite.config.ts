import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  // Two apps from one project: the consumer PWA (index.html) and the ops /
  // governance console (ops.html → /ops), which shares the chain glue but has
  // no shared nav and no service worker. See src/ops/.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        ops: fileURLToPath(new URL("./ops.html", import.meta.url)),
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
});
