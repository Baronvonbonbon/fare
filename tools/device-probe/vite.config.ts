import { defineConfig } from "vite";
import { resolve } from "node:path";

// `pad` uploads a static directory to Bulletin and points a .dot contenthash at
// it, so everything must resolve relatively — there is no server and no origin.
export default defineConfig({
  base: "./",
  build: { target: "es2022", outDir: "dist" },
  server: {
    // The probe imports the real driver-flow modules from web/src, which live
    // outside this package root.
    fs: { allow: [resolve(__dirname, "../..")] },
  },
});
