import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  pack: { deps: { resolveDepSubpath: true }, entry: ["src/cli.ts"], dts: false, sourcemap: false },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    sortImports: {},
    sortPackageJson: true,
  },
});
