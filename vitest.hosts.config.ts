import { defineConfig } from 'vitest/config';

// Tier-3 suite (testing-plan Phase 5): drives REAL MCP hosts against the
// Phase 4 fixture. Needs host binaries and model credentials, spends real
// model tokens per run, and a model-driven step can fail for reasons
// unrelated to this code — so it is its own entry point (`yarn test:hosts`),
// never part of `yarn test` / `yarn verify` / PR CI. Non-blocking by design.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/hosts/**/*.spec.ts'],
    globalSetup: ['tests/hosts/global-setup.ts'],
    // One host session at a time: parallel TUIs fight over credentials,
    // model rate limits and PTY resources.
    fileParallelism: false,
    // Generous: nightly CI runs an Ollama model on CPU, where a session that
    // takes seconds locally can take minutes (the first dispatch run proved
    // it — a thinking model blew every budget before its first tool call).
    // Must exceed the SUM of a test's chained inner waits (interactive:
    // 120s ready + 780s elicitation + 60s render + 120s answer = 1080s), so
    // a slow run fails on the diagnostic assertion, not a generic timeout.
    testTimeout: 1_200_000,
    hookTimeout: 60_000,
  },
});
