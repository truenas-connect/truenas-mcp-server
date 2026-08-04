# Testing plan — tiers 0–2

**Status:** working document, 2026-08-04. Temporary. It exists so the tier
model and the phase breakdown are reviewable in one place; fold it into
permanent documentation once tiers 0–2 have landed and tiers 3–4 have a home.

All measurements below were taken on 2026-08-04 against `main` of both repos.

## Scope boundary

`@truenas/api-client` is a **trusted dependency**. We are consumers of it and
rely on it having its own CI. Everything at or below `client.api.call()` and
`ClientFactory` — endpoint existence, wire format, transport, reconnection,
auth mechanics, response typing — is out of scope for our tests. Everything
above is ours.

Practically: mock at the `api.call` / `SystemHandle` seam, which is what
`executor.spec.ts` and `tools.spec.ts` in the base repo already do. Do not
build fakes that reimplement the middleware protocol, and do not write
contract tests that verify api-client's surface.

What remains ours, because api-client's CI cannot see our code: the arguments
we construct (for example the query filter in `assertDatasetExists`), our
interpretation of responses, and plan/execute correspondence.

## Tier model

Tiers are layers of *risk*, not layers of the same test repeated at larger
scope. Each covers something the others structurally cannot.

| Tier | What it covers | Where it runs | Blocking |
| --- | --- | --- | --- |
| 0 | Unit / component | GitHub Actions, every PR | yes |
| 1 | MCP protocol semantics, in-process | GitHub Actions, every PR | yes |
| 2 | Real MCP session over real stdio, against the built artifact | GitHub Actions, every PR | yes |
| 3 | Real MCP clients (Claude Code CLI, Codex CLI, Ollama-backed) | nightly, TBD | no |
| 4 | Real TrueNAS | Jenkins, nightly | TBD |

Tiers 0–2 need no secrets, no network egress and no lab access, which is what
makes them safe as required checks on every PR. Tiers 3–4 need model
credentials and lab access respectively, and are out of scope for this
document beyond the open questions at the end.

## What exists today

### Tier 0 — complete

154 tests, all green: 76 in `truenas-mcp-base` (6 files), 78 in
`truenas-mcp-server` (7 files). CI runs `typecheck`, `lint`, `test` and
`build` on Node 22 and 24.

### Tier 1 — partial

`src/server.spec.ts` (16 tests) drives a real MCP `Client` against a real
`Server` over `InMemoryTransport`. It already covers both elicitation paths,
the plan/confirm fallback, audit invariants, and the `requireElicitation`
default-deny. What is missing is systematic coverage of the client-capability
matrix rather than individual cells — see Phase 1.

### Tier 2 — absent

Three separate gaps combine to leave it uncovered:

- `src/cli.spec.ts` (8 tests) **does** spawn a real subprocess, deliberately
  via `tsx src/cli.ts` rather than `dist/` so tests cannot run against a stale
  build. But every test either errors before connecting or is
  `--help` / `--version`. None reaches a live MCP session.
- `src/server.spec.ts` reaches a live MCP session, but over `InMemoryTransport`
  rather than real stdio pipes.
- Nothing exercises `dist/` at all: shebang survival, `bin` mapping,
  `files: ["dist"]` completeness and tsup output are unverified.

Tier 2 is exactly the intersection: **a real MCP session, over real stdio
pipes, against the built artifact.**

## Coverage policy

### Measured today

```
                  Stmts   Branch   note
server (all)      79.02    88.41
  server.ts      100.00    92.30
  gate.ts        100.00    92.30
  shutdown.ts    100.00   100.00
  version.ts     100.00   100.00
  trace.ts        96.55    85.71
  init.ts         95.36    87.50
  config.ts       89.10    86.88
  audit.ts        83.63    84.61
  cli.ts           0.00   100.00   tested, but by subprocess
  index.ts         0.00   100.00   re-export barrel

base (all)        84.16    94.17
  execution/       97.81    93.69
  registry/        97.77    93.22
  catalog/         96.77    95.23
  tools/           93.10    96.15
  scripts/smoke     0.00      --   manual script, not a test
  src/index.ts      0.00      --   re-export barrel
  catalog/tool      0.00      --   types only, no runtime exports
```

The headline numbers are misleading. `cli.ts` reads 0% despite having 8 tests,
because `cli.spec.ts` spawns it as a subprocess and v8 coverage in the parent
process cannot see into it. The remaining drag is two re-export barrels, a
types-only file and a manual script. Excluding those artifacts, both repos sit
at roughly 93–100% statements and 92–96% branch on real logic.

### Rules

1. **One coverage number per repo, not one per tier.** Every tier executes the
   same source files. Measuring per tier would push each tier to redundantly
   re-cover the same lines, which is the opposite of the point.

2. **Coverage is sourced from tiers 0–1 only.** Tiers 2–4 spawn processes and
   are asserted behaviourally. `cli.ts` at 0% is what counting them looks like,
   and Phases 3 and 4 add more subprocess tests, so this compounds rather than
   resolving itself.

3. **Branch, not line.** This codebase is full of fail-closed logic
   (`requireElicitation !== false`, the role gate, token validation). Line
   coverage flatters it, because the dangerous path is the one not taken.

4. **Floors are set at measured level and ratcheted up, never set
   aspirationally.** A gate that fails on the day it lands gets bypassed and
   then ignored.

5. **A global average is not the gate.** A single number lets a safety-critical
   file rot while a well-covered one carries the average.

### Gates

Two, both blocking:

- **Ratchet** — global branch percentage may not decrease.
- **Safety floor** — 95% branch, per file, on the files where the safety model
  lives. All are at 92–95% today, so this is a short reach.

| Repo | Files under the safety floor |
| --- | --- |
| `truenas-mcp-server` | `src/server.ts`, `src/gate.ts` |
| `truenas-mcp-base` | `src/execution/executor.ts`, `src/execution/confirmation.ts`, `src/catalog/catalog.ts`, `src/registry/system-registry.ts` |

Vitest supports glob-scoped thresholds under `test.coverage.thresholds`, so
both gates live in `vitest.config.ts` rather than in CI scripting.

### What coverage cannot do

Coverage cannot tell you Phase 1 succeeded. 100% branch on `server.ts` is
reachable without ever testing the {no-elicitation × `requireElicitation:
false`} cell alongside a read-only call. The matrix is the deliverable; the
percentage is a regression alarm. Do not let the number substitute for the
reasoning.

## Phases

Each phase is one PR. Phases 3 and 4 depend on Phase 2; the rest are
independent.

### Phase 0 — coverage measurement and gates

Two small PRs, one per repo, since the safety-floor files span both.

**Deliverables**

- `vitest.config.ts` in both repos gains a `coverage` block.
- Exclusions, each with a comment stating why: `scripts/` and `src/index.ts`
  and `src/catalog/tool.ts` (base); `src/index.ts` and `src/cli.ts` (server).
  `cli.ts`'s exclusion comment must say it is subprocess-tested by
  `cli.spec.ts`, so a future reader does not "fix" it by deleting those tests.
- Global branch threshold set to the measured post-exclusion figure.
- Per-file 95% branch thresholds on the safety-floor files above.
- CI calls the existing `test:coverage` script instead of `test`. The script
  and `@vitest/coverage-v8` are already present in both repos, so this is a
  CI-wiring change plus the config block — nothing new to install.

`src/version.ts` is deliberately **not** excluded. It has runtime code
(`createRequire(import.meta.url)('../package.json')`), so it does report, but
it already measures 100% statements and 100% branch and needs no special
handling.

**Acceptance:** CI fails when a safety-floor file drops below 95% branch, and
fails when the global branch figure decreases. Both verified by temporarily
deleting a test locally.

### Phase 1 — protocol conformance matrix (tier 1)

**Deliverables**

Extend `src/server.spec.ts` from individual cells to the full matrix:

- {client advertising elicitation, client not advertising it} ×
  {`requireElicitation` unset, `true`, `false`} — six combinations.
- Read-only calls asserted unaffected in all six.
- `tools/list` annotation correctness per tool: `readOnlyHint` and
  `destructiveHint` must agree with `mutating` for every catalog entry, not
  just the sampled one.

**Acceptance:** every one of the six cells has an explicit named test. The
refusal cells assert no token is minted and `executor.execute` is not called
for the mutating tool. No new infrastructure, no production change.

**Note:** several cells already exist. Extend and reorganise rather than
duplicating — check existing test names before adding.

### Phase 2 — mirror the `init.ts` client-factory seam onto the serve path

The only phase that changes production code. Agreed 2026-08-04.

**Problem:** the serve path constructs its clients with `defaultClientFactory`
and offers no way to substitute them.

Note carefully *where* that happens, because it is not where it first appears.
`connectSystems(registry, fileCredentialProvider(config))` is called at
`src/cli.ts:102`, inside **`main()`** — before serving begins. `serve()` at
`src/cli.ts:115` then receives an **already-populated registry** and never
touches client construction at all. Giving `serve()` an optional
`clientFactory` would therefore thread it nowhere: by the time `serve()` runs,
the clients already exist.

`init.ts` already has exactly the seam this phase needs, at `src/init.ts:345`:

```ts
const factory = options.clientFactory ?? defaultClientFactory;
```

wrapped in a tracking factory around its own `connectSystems` call
(`src/init.ts:341-354`). `init.ts` imports `defaultClientFactory` and
`ClientFactory`; `cli.ts` imports neither. So the accurate framing of this
phase is *mirror the `init.ts` seam onto the serve path*, not *extract
`serve()`*.

**Deliverables**

- Export a single entry point that spans **connect and serve together** — the
  `connectSystems` call currently in `main()` plus the body of `serve()`. A
  suggested shape:

  ```ts
  export interface RunServerOptions {
    configPath: string;
    tracePath?: string;
    /** Injectable for tests; defaults to the core's API-key factory. */
    clientFactory?: ClientFactory;
  }
  export function runServer(config: ServerConfig, options: RunServerOptions): Promise<void>;
  ```

- `runServer` owns: trace-file preparation, `new SystemRegistry()`,
  `connectSystems(registry, fileCredentialProvider(config), factory)`, the
  serve body, and the existing `closeAll()` rollback on startup failure.
- `main()` retains argument parsing, config loading, and the TLS policy plus
  its stderr warning.
- Export `runServer` from `src/index.ts`.

**Two ordering invariants must survive the move.** Both are load-bearing and
both currently carry comments in `cli.ts` explaining why:

- The trace file is prepared *before* anything serves, so an unusable path
  fails at startup rather than killing a connected server.
- `enableTracing` is called immediately after `server.connect(transport)` with
  **no intervening `await`**, or the initialize handshake escapes the trace.

**Rationale for the shape:** the real binary and the Phase 4 fixture must drive
the *same* wiring. If the exported unit began after connect, the fixture would
have to perform its own connect, and would then no longer be testing the real
path — including that `fileCredentialProvider(config)` is the provider used and
that a connect failure closes the clients that did connect.

**Explicitly rejected:** a `TRUENAS_MCP_CLIENT_FACTORY` environment variable.
It is easier, but it is a production surface that lets anyone with environment
control swap out the connection layer. Not worth it for test convenience.

### Phase 3 — built-artifact smoke (tier 2a)

**Deliverables**

- `yarn build`, then spawn `dist/cli.js` directly (not via `tsx`).
- Cases: `--version`, `--help`, missing config file, unusable `--trace` path.
- CI ordering: `build` must run before this suite, either as a step or a
  separate job.

**Acceptance:** the shipped artifact starts and reports correctly. Catches
shebang loss, `bin` mapping errors, `files: ["dist"]` gaps and tsup config
regressions — none of which `tsx`-on-source can see.

### Phase 4 — stdio session e2e (tier 2b)

**Deliverables**

- A fixture importing the exported `runServer` (Phase 2) from `dist/`, passing
  a fake `ClientFactory` so the real connect-and-serve path runs against
  substituted clients over real stdio pipes.
- Driven by the MCP SDK `Client`.
- Assertions: initialize handshake; `tools/list`; read-only call round-trip;
  mutating call refused under the default; **stdout carries nothing but
  JSON-RPC frames**; stderr carries the startup banner; SIGTERM drains the
  audit sink; `--trace` writes frames.

**Acceptance:** all of the above. The stdout-purity assertion is the highest
value one — stray stdout writes silently break every MCP client at once, and
nothing checks for it today.

## Deferred

**CD is out of scope** while this is a prototype, revisited once tiers 0–2 have
landed and the release shape is settled. Neither repo currently has a release
config, publish job or dependency bot.

One consequence remains live and is CI rather than CD: the server pins
`@truenas/mcp-base` by commit (`git+…#main`, resolved to a commit in
`yarn.lock`), so server CI can build against a base that is behind base `main`.
At time of writing the pin is `5919e31` while base `main` is `493fea0`. A
scheduled job comparing the two, failing on divergence, would close this
without any release machinery. Not currently planned.

## Open questions — tiers 3 and 4

Carried here so they are not lost; none block tiers 0–2.

- Is there an existing Jenkins job for the from-scratch TrueNAS spin-up that
  tier 4 can build on?
- Does Jenkins have outbound access to `api.github.com` for commit-status
  reporting? The proposed direction is Jenkins-as-driver, reporting outward,
  rather than GitHub Actions reaching into the lab.
- Which TrueNAS versions must be in the tier 4 matrix?
- For tier 3, is there appetite for model API calls in CI, or should the
  Ollama-backed path be the only LLM-driven one?
- Tier 3 assertions should read the `--trace` JSONL rather than model output,
  so they stay deterministic. Tier 3 remains non-blocking regardless.
