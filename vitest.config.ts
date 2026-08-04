import { fileURLToPath } from 'node:url';
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

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
    coverage: {
      provider: 'v8',
      exclude: [
        ...coverageConfigDefaults.exclude,
        // Re-export barrel; no logic of its own.
        'src/index.ts',
        // Subprocess-tested by cli.spec.ts, which spawns `tsx src/cli.ts`;
        // v8 coverage in the parent process cannot see into the child, so it
        // reads 0% here despite being tested. Do not "fix" this by deleting
        // those tests.
        'src/cli.ts',
      ],
      // Floors, not targets: set at the measured level so a decrease fails CI.
      // Raised by hand in the same PR that raises the coverage — never lowered,
      // never auto-updated. See docs/testing-plan.md.
      // Branch is the primary gate; the statements floor exists because v8
      // reports a file that no test touches as 100% branch (no branches
      // recorded), so a branch-only floor cannot see a file losing all its
      // tests at once.
      thresholds: {
        branches: 88,
        statements: 94,
        // Per-file floors on the files where the safety model lives.
        'src/server.ts': { branches: 92, statements: 100 },
        'src/gate.ts': { branches: 92, statements: 100 },
      },
    },
  },
});
