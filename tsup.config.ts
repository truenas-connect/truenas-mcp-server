import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
  },
  {
    // The CLI is ESM-only (it is executed, not imported) and keeps its shebang.
    entry: ['src/cli.ts'],
    format: ['esm'],
    sourcemap: true,
    treeshake: true,
  },
]);
