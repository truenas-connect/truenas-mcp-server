import { defineConfig } from 'vitest/config';

// Tier-2 suite (testing-plan Phases 3-4): runs against dist/, so it must run
// AFTER `yarn build`. CI orders it that way, and the suite fails fast with a
// clear message when the artifact is missing. Kept out of vitest.config.ts so
// plain `yarn test` (tiers 0-1, pre-build) never touches it, and carries no
// coverage block: coverage is sourced from tiers 0-1 only (plan rule 2),
// tier 2 is asserted behaviourally.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Top level only: tests/hosts/ is tier 3 (vitest.hosts.config.ts) —
    // model-spending, never on PRs.
    include: ['tests/*.spec.ts'],
  },
});
