# Testing plan — tiers 0–2

**Status:** working document, last updated 2026-08-05. Temporary. It exists so
the tier model and the phase breakdown are reviewable in one place; fold it into
permanent documentation once tiers 0–2 have landed and tiers 3–4 have a home.

**Progress: tiers 0–2 are complete.** Phases 0, 1 and 1b (server#7,
server#9, base#5, base#6), Phase 2 (server#11), Phase 3 (server#13) and
Phase 4 (server#15) have all landed. **Phase 5 — tier 3, real MCP hosts — is
specified below and unblocked.** Tier 4 still needs a home.

Figures below are measured against `main` of both repos as of 2026-08-05, after
Phase 1/1b. The "Measured today" block under Coverage policy is the exception:
it is kept at its 2026-08-04 pre-Phase-0 values on purpose, because the
reasoning that follows it is about those numbers.

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

168 tests, all green: 80 in `truenas-mcp-base` (6 files), 88 in
`truenas-mcp-server` (7 files). CI runs `typecheck`, `lint`, `test:coverage`
and `build` on Node 22 and 24, with the coverage gates below blocking.

### Tier 1 — complete

`src/server.spec.ts` drives a real MCP `Client` against a real `Server` over
`InMemoryTransport`. Phase 1 completed it: all six cells of
{elicitation, none} × {`requireElicitation` unset, true, false} have explicit
named tests for mutating calls, and all six are asserted not to affect
read-only calls. `tools/list` annotation agreement is checked against every
default-catalog entry rather than a sample.

### Tier 2 — complete

Tier 2 is the intersection the tiers below cannot reach: **a real MCP
session, over real stdio pipes, against the built artifact.** It landed in
two suites under `tests/`, both run by `yarn test:dist` after `yarn build`:

- `tests/dist.spec.ts` (Phase 3) — the artifact smoke: `dist/cli.js` spawned
  directly, plus shebang survival, `bin` mapping, `files: ["dist"]` /
  exports-map completeness.
- `tests/stdio.spec.ts` (Phase 4) — the session e2e: a fixture running the
  exported `runServer` from `dist/` with a substituted `ClientFactory`
  (the Phase 2 seam), driven by the MCP SDK `Client`, plus a raw-pipe test
  auditing that stdout carries nothing but JSON-RPC frames.

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

3. **Branch is the primary gate; statements is the backstop.** This codebase is
   full of fail-closed logic (`requireElicitation !== false`, the role gate,
   token validation), and line coverage flatters it because the dangerous path
   is the one not taken. But a branch floor *alone* cannot see a file that
   loses all of its tests: v8 records no branches for an untouched file and
   reports it as 100% branch. Every gate therefore carries both floors — see
   Gates for the demonstration.

4. **Floors are set at measured level and raised deliberately, never set
   aspirationally.** A gate that fails on the day it lands gets bypassed and
   then ignored. A target above the measured figure is not a floor — it is
   work, and it needs a phase that owns it.

5. **A global average is not the gate.** A single number lets a safety-critical
   file rot while a well-covered one carries the average.

### Gates

Two, both blocking, and each carrying **a branch floor and a statements floor**:

- **Global floor** — the repo-wide figures may not decrease.
- **Safety floor** — per-file thresholds on the files where the safety model
  lives.

Global floors, set at the measured **post-exclusion** figures (which differ
from the raw numbers in the table above, since the exclusions change the
denominator):

| Repo | Measured stmt / branch | Floor stmt / branch |
| --- | --- | --- |
| `truenas-mcp-base` | 97.59 / 96.34 | 97 / 96 |
| `truenas-mcp-server` | 94.17 / 89.61 | 94 / 89 |

Per-file safety floors:

| Repo | File | Measured stmt / branch | Floor stmt / branch | Landed in |
| --- | --- | --- | --- | --- |
| server | `src/server.ts` | 100.00 / 100.00 | 98 / 98 | Phase 1 |
| server | `src/gate.ts` | 100.00 / 100.00 | 98 / 98 | Phase 1 |
| base | `src/execution/executor.ts` | 100.00 / 95.23 | 97 / 95 | Phase 1b |
| base | `src/registry/system-registry.ts` | 100.00 / 96.55 | 97 / 96 | Phase 1b |
| base | `src/execution/confirmation.ts` | 100.00 / 97.05 | 97 / 97 | Phase 1b |
| base | `src/catalog/catalog.ts` | 96.77 / 95.00 | 96 / 95 | Phase 0 |

All six now clear the 95 branch target. `catalog.ts` sits at exactly its floor
and `confirmation.ts` 0.05 above — the correct outcome of flooring at measured
level, and stable because coverage is deterministic (both repos pass on the
Node 22 and 24 CI matrix). A vitest or v8 upgrade that shifts branch accounting
will trip these two first; the fix then is to re-measure and re-floor, never to
shave the floor down.

**Why both floors.** A branch-only floor cannot detect a file that loses all of
its tests. v8 records no branches for a file nothing touches and reports it as
100% branch, which passes any branch floor. Demonstrated on the Phase 0
branches by deleting one spec and re-running:

```
executor.ts   0% stmt | 100% branch   (base, with executor.spec.ts removed)
gate.ts       0% stmt | 100% branch   (server, with server.spec.ts removed)
```

Both sail past their 92 branch floors; only the statements floor fails the
build. The same trap exists one level up — base's *global* branch figure rose
to 95.42 while the code under test shrank.

Statements floors are `floor(measured)`, except where a file already measures
100%: `server.ts` and `gate.ts` are floored at 98 rather than 100, deliberately.
The statements gate is a wholesale-loss backstop, not a full-line-coverage
mandate, and 98 leaves room for an honestly-excluded defensive line.

**Phase 0 set these floors at measured level, not at the 95 branch target.**
Five of the six were below 95 branch at the time, so landing the target as the
initial floor would have failed CI the day Phase 0 merged — exactly what rule 4
forbids. Reaching 95 is real work, and it belongs to a phase that owns it:
`server.ts` and `gate.ts` are lifted by Phase 1 as a side effect of the matrix,
and the three base files have no other phase touching them, so they get
Phase 1b.

The 95 target is a minimum, not a stopping point. When the phase that owns a
file lands its coverage above the target, the floor is set at the *achieved*
level per rule 4 — less the same headroom the statements floors use: a file
measuring 100 is floored at 98, leaving room for one honestly-excluded
defensive branch rather than mandating full coverage forever.

**On the word "ratchet".** Vitest's `thresholds` are floors, not ratchets: a
number fails on decrease but never raises itself. `coverage.thresholds
.autoUpdate` does rewrite the config with current values, but it is
deliberately **not** used here — it would mean CI rewriting a tracked file.
Floors are raised by hand, in the same PR that raises the coverage.

Vitest supports glob-scoped thresholds under `test.coverage.thresholds`, so
both gates live in `vitest.config.ts` rather than in CI scripting.

### What coverage cannot do

Coverage cannot tell you Phase 1 succeeded. 100% branch on `server.ts` is
reachable without ever testing the {no-elicitation × `requireElicitation:
false`} cell alongside a read-only call. The matrix is the deliverable; the
percentage is a regression alarm. Do not let the number substitute for the
reasoning.

## Phases

Each phase is one PR.

```
Phase 0   ->  Phase 1   (server: raises the floors Phase 0 recorded)   DONE
          ->  Phase 1b  (base:   raises the floors Phase 0 recorded)   DONE
Phase 2   ->  Phase 3                                                  DONE
          ->  Phase 4                                                  DONE
Phase 4   ->  Phase 5   (tier 3: real MCP hosts)                       TODO
```

Phases 0 through 4 have landed — their sections below are kept as the record
of what was decided and why, since the rationale still governs how the floors
are maintained. **Phase 5 is the next piece of work**, and needs no tier-4
infrastructure to start.

### Phase 0 — coverage measurement and gates *(landed: base#5, server#7)*

Two small PRs, one per repo, since the safety-floor files span both.

**Deliverables**

- `vitest.config.ts` in both repos gains a `coverage` block.
- Exclusions, each with a comment stating why: `scripts/` and `src/index.ts`
  and `src/catalog/tool.ts` (base); `src/index.ts` and `src/cli.ts` (server).
  `cli.ts`'s exclusion comment must say it is subprocess-tested by
  `cli.spec.ts`, so a future reader does not "fix" it by deleting those tests.
- Global branch **and statements** thresholds set to the measured
  post-exclusion figures.
- Per-file branch and statements thresholds on the safety-floor files, each set
  at its **measured level** per the Gates table — not at the 95 branch target.
  Phase 0 must land green.
- `coverage.include` scoped to `src/**/*.ts`. Vitest 3 pulls unimported files
  into the denominator via the `coverage.all` default, but vitest 4 drops that
  option, and without an explicit include a new source file that no spec
  imports would stop being reported at 0%.
- CI calls the existing `test:coverage` script instead of `test`. The script
  and `@vitest/coverage-v8` are already present in both repos, so this is a
  CI-wiring change plus the config block — nothing new to install.

`src/version.ts` is deliberately **not** excluded. It has runtime code
(`createRequire(import.meta.url)('../package.json')`), so it does report, but
it already measures 100% statements and 100% branch and needs no special
handling.

**Acceptance:** CI is green on landing, and fails when any safety-floor file
drops below its recorded floor or when a global figure decreases. Both verified
by temporarily deleting a test locally — and the failure must name the file, not
just report a global miss.

A per-file threshold key that matches no file **passes vacuously**. Renaming
any safety-floor file must carry its threshold key along, or the floor silently
disappears.

### Phase 1 — protocol conformance matrix (tier 1) *(landed: server#9)*

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

**Coverage side effect:** this phase is what lifts `server.ts` and `gate.ts`
from 92.30 branch to the 95 target (uncovered today: `server.ts` lines 96 and
132, `gate.ts` line 68). Raise both **branch** floors to 95 in this PR, not in
Phase 0. Leave the statements floors where Phase 0 set them.

**Outcome:** both files reached 100% branch, so the floors landed at 98 rather
than the 95 minimum — the headroom rule under Gates.

### Phase 1b — raise the base safety files to the 95% branch floor *(landed: base#6)*

Base repo. Independent of Phase 1, which is server-only.

**Problem:** `executor.ts` (92.06), `system-registry.ts` (93.22) and
`confirmation.ts` (94.11) sit below the 95 target with no other phase touching
them. Without this phase the target is aspirational, which rule 4 forbids.

**Deliverables**

Cover the outstanding branches, then raise each file's **branch** floor to 95
(leaving its statements floor as Phase 0 set it):

| File | Uncovered today |
| --- | --- |
| `src/execution/executor.ts` | 83-84, 115-116 |
| `src/registry/system-registry.ts` | 91-92, 173 |
| `src/execution/confirmation.ts` | 99-100 |

**Acceptance:** all three at or above 95% branch, floors raised in the same PR.

**Outcome:** `executor.ts` 95.23, `system-registry.ts` 96.55,
`confirmation.ts` 97.05, floored at 95 / 96 / 97 respectively. The judgement
call below was exercised once: the unreachable `no result for system` guard in
`executor.ts` was suppressed with a `v8 ignore` block carrying its proof
(`partitionByRole` assigns every target to exactly one of allowed/denied, and
`resolve` dedupes names) rather than covered by a contrived test.

**Judgement required:** look at what each uncovered branch actually is before
writing a test for it. An unreachable defensive branch is better excluded with
a comment explaining why than covered by a contrived test that exists only to
move a number. Rule 4's point is that the figure should track real assurance —
gaming it is worse than leaving the floor where it is and saying so.

### Phase 2 — mirror the `init.ts` client-factory seam onto the serve path *(landed: server#11)*

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
- `runServer` **also applies the TLS policy and emits its stderr warning.**
  Today `applyTlsPolicy` runs at `cli.ts:85-91`, before `connectSystems` at
  `cli.ts:102`, because clients read the process-global TLS setting at connect
  time. Leaving TLS in `main()` while `connectSystems` moves into `runServer`
  would turn that ordering into a cross-boundary caller contract — and a caller
  that got it wrong would silently start rejecting self-signed certificates,
  with nothing in the error pointing at the cause. Moving it removes the
  contract instead of documenting it.
- `main()` retains argument parsing and config loading only.
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

### Phase 3 — built-artifact smoke (tier 2a) *(landed: server#13)*

**Deliverables**

- `yarn build`, then spawn `dist/cli.js` directly (not via `tsx`).
- Cases: `--version`, `--help`, missing config file, unusable `--trace` path.
- CI ordering: `build` must run before this suite, either as a step or a
  separate job.

**Acceptance:** the shipped artifact starts and reports correctly. Catches
shebang loss, `bin` mapping errors, `files: ["dist"]` gaps and tsup config
regressions — none of which `tsx`-on-source can see.

### Phase 4 — stdio session e2e (tier 2b) *(landed: server#15)*

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

### Phase 5 — real MCP hosts (tier 3) *(next)*

Unblocked and **independent of tier 4**: Phase 4's fixture runs `runServer`
with a substituted `ClientFactory`, so a real host can drive a real server
against a fake backend. Tier 3 needs no TrueNAS, no lab and no Jenkins.

**What tier 3 uniquely proves.** Tiers 0–2 all drive the server with the MCP
SDK, an implementation we control. Tier 3 answers what no lower tier can: does
a *real* host advertise the capabilities we depend on, route our requests, and
answer them the way our gate assumes — and, above all, **can the elicitation
gate be bypassed by a host we do not control**.

#### Findings from a working prototype (2026-08-07)

Run against `claude` CLI headless, with the Phase 4 fixture as the server and
`--trace` as the assertion substrate. All of this is measured, not assumed.

```
clientInfo    claude-code 2.1.223
protocol      2025-11-25
capabilities  {"roots":{"listChanged":true},"elicitation":{}}
```

- **Claude Code advertises elicitation.** The `requireElicitation: true`
  default therefore does *not* refuse real Claude Code users — they get the
  in-UI approval path, which is the whole point of the default.
- **The gate fires against a real host.** A mutating call produced
  `send elicitation/create` followed by the host's answer.
- **Headless always cancels the elicitation.** Verified across
  `--permission-mode acceptEdits`, `bypassPermissions` and `dontAsk` — all
  three returned `action=cancel`. Permission modes govern *tool* approval, not
  elicitation.
- **No supported hook to answer it.** `--output-format stream-json` exposes
  `assistant`, `user`, `system`, `result` and `rate_limit_event` events; no
  elicitation event appears, so there is nothing to reply to.

#### Verifying the gate is not bypassed

This is the point of the phase, and it is a *negative* property: no mutating
tool may execute without an elicitation the user answered. Absence claims need
coverage in depth, and the bypass vectors do not all live where a real host can
see them.

```
vector                                     caught by
new mutating tool not routed via the gate  catalog + annotation checks (tier 1)
token minted without an approval           mintSpy assertions         (tier 1)
executor running without a token           confirmation tests         (base)
requireElicitation off by default          six-cell matrix            (tier 1)
gate skipped over real stdio               Phase 4 refusal test       (tier 2)
a HOST that auto-accepts unattended        -- only tier 3 sees this
```

Only the last row needs a real host. Everything above it is asserted already,
so tier 3 is not re-proving the gate — it is closing the one hole the other
tiers structurally cannot reach: a host we do not control answering on the
user's behalf.

**The headless `cancel` is the assertion, not a limitation.** Headless is
exactly the unattended case: no human is present and no plan has been shown to
anyone. A host that returned `accept` there would silently defeat the gate and
run mutations nobody approved. Claude Code returning `cancel` is the correct
behaviour, and pinning it is a genuine regression check — if a future host
version starts auto-accepting, this is the only test in the suite that would
notice.

Assertions, per host:

- the host advertises `elicitation` in its initialize capabilities;
- a mutating call causes `elicitation/create` to be sent before anything
  executes;
- **an unattended run never answers `accept`**;
- a non-accept answer executes nothing and mints no token.

#### Footnote: automating the accept path

Deliberately out of scope. It is not reachable through any supported Claude CLI
surface (the four probes above), and reaching it is not what this phase is for.

The accept path is already covered at the right layer: `server.spec.ts` drives a
real MCP `Client` that accepts across all six matrix cells, and Phase 4 proves
that wiring over real stdio. A purpose-built client that auto-accepts would be
*our* client again, which is what tier 3 exists to stop relying on.

Driving an interactive host with `pexpect` would depend on the TUI rendering an
elicitation prompt (unverified) and would test a terminal renderer as much as a
protocol. If the accept path against a real host is later judged essential, that
is the fallback — as its own decision, not assumed into this phase.

#### Harness shape — generic core, thin per-host adapter

The trace is *our server's* view of the session, so every assertion is
host-agnostic by construction. That is what makes one harness viable.

```
shared (host-agnostic)              per-host adapter (~20 lines)
  the Phase 4 fixture as server       how to declare an MCP server
  --trace JSONL as the substrate      how to run one prompt headless
  the assertions below                what the client advertises
```

Each adapter supplies three things and nothing else: a config file or flag
that points the host at the fixture, an argv for a single non-interactive
prompt, and the expected capability set. A shared spec then runs every adapter
through the same checks, so adding Codex CLI or Goose later is an adapter plus
a row — not a new harness.

**Assertions, all read from the trace, none from model prose.** The prototype
demonstrated why: across two runs the model's wording differed completely
while the frame sequence was identical.

```
initialize advertises the capabilities the adapter declares
tools/list returns the full default catalog
a read-only call round-trips and returns the fixture's data
a mutating call is gated per the host's elicitation support
nothing executes without an accept
```

#### Client matrix

Verified status is marked explicitly; unverified rows are candidates, not
claims.

| Host | Headless | Elicitation | Status |
| --- | --- | --- | --- |
| Claude Code CLI | yes | yes, cancels headless | **verified 2026-08-07** |
| MCP Inspector | CLI mode | n/a | not yet probed |
| Codex CLI | likely | unknown | not installed here |
| Goose / Ollama-backed | likely | likely not | not installed here |
| Claude Desktop, IDE plugins | no | yes | manual only |

The probe that fills a row is the same three steps each time: point the host at
the fixture, run one prompt, read the initialize frame. Roughly ten minutes per
client, and it must be run before a row claims anything.

**Where it runs.** Nightly, non-blocking, not on PRs — it needs model
credentials, and a model-driven step is the one part of the suite that can fail
for reasons unrelated to the code. The Ollama-backed path, once a host is
installed, is the only LLM-driven option with no per-run cost.

**Deliberately not covered.** Whether the *model* chooses the right tool. That
is provider behaviour, not ours, and asserting it would make the suite fail
whenever a model updates.

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
- For tier 3, is there appetite for model API calls in a nightly job, or
  should an Ollama-backed host be the only LLM-driven one? This is the one
  tier-3 question Phase 5 does not answer for itself.
- Should the elicitation *accept* path be pursued against a real host at all?
  Phase 5 argues no: it is covered at tier 1, no supported Claude CLI surface
  reaches it, and the phase's actual goal — proving the gate cannot be
  bypassed — is served better by asserting that an unattended run never
  accepts. Reopen deliberately if that judgement is wrong.
