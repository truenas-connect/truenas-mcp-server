import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  // Resolve the tsconfig path alias explicitly; `*.spec.ts` files are excluded
  // from tsconfig.json (they live in tsconfig.spec.json), so a tsconfig-driven
  // plugin would not map `@/…` for them.
  resolve: {
    alias: [{ find: /^@\//, replacement: `${srcDir}/` }],
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
  },
});
