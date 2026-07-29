# @truenas/mcp-server

Standalone (community) TrueNAS MCP server: a self-hosted [Model Context
Protocol](https://modelcontextprotocol.io) server you run locally with any MCP
host (Claude Desktop, MCP Inspector, ...), configured with your own TrueNAS
host(s) and API key(s). Fully functional air-gapped — no cloud account.

> **Status:** prototype. This is the stdio adapter over
> [`@truenas/mcp-base`](https://github.com/truenas-connect/truenas-mcp-base)
> (consumed straight from its `prototype` branch as a git dependency), which
> holds the tool catalog, system registry, multi-system fan-out, and the
> plan/confirm safety model. See that repo's `docs/architecture-proposal.md`
> for the overall design.

## What works

- **Tools** (the base sketch's catalog): `system_info`, `storage_pool_status`,
  `storage_list_datasets` (read-only) and `snapshots_create` (mutating,
  two-phase plan/confirm).
- **Multi-system**: register several systems in the config; every tool takes a
  `systems` argument (name, list, or `"all"`, defaulting when one system is
  registered) and returns structured per-system results.
- **Plan/confirm**: mutating tools never execute without a confirmation token
  minted from a user approval (see [Confirmation flow](#confirmation-flow)).
- **Audit**: every tool execution is recorded — to stderr, or as JSONL when
  `auditLog` is configured.

## Setup

Requires Node.js ≥ 22.

The quickest way to create the config file is the interactive helper — it
prompts for each system (the API key input is masked), writes the file with
`chmod 600`, and offers to verify connectivity right away:

```bash
npx -y github:truenas-connect/truenas-mcp-server#main init
# or from a checkout (runs from source, no build needed):
yarn run init
```

Or write `~/.config/truenas-mcp/config.json` by hand (point at another path
with `--config` / `TRUENAS_MCP_CONFIG`):

```json
{
  "systems": [
    {
      "name": "nas-a",
      "host": "nas-a.local",
      "username": "truenas_admin",
      "apiKey": "1-abcd..."
    },
    {
      "name": "nas-b",
      "hostnames": ["nas-b.local", "10.0.0.5"],
      "username": "truenas_admin",
      "apiKey": "2-efgh..."
    }
  ],
  "auditLog": "~/.local/state/truenas-mcp/audit.jsonl"
}
```

- `name` is how the LLM addresses the system (`"all"` is reserved).
- `host` (one) or `hostnames` (primary first, then fallbacks) — exactly one of
  the two. Each entry is a bare `host[:port]` (no URL scheme or path); write
  IPv6 literals bracketed, e.g. `"[2001:db8::1]"`.
- API keys are user-scoped TrueNAS API keys (System → API Keys). The file
  holds credentials: `chmod 600` it (the server warns otherwise).
- `auditLog` is optional; without it audit events go to stderr.
- `allowSelfSigned` (optional): accept TrueNAS's default self-signed
  certificate (`init` asks about this). Node has no per-connection TLS hook,
  so this disables certificate verification **for the whole server process**
  — prefer installing a trusted certificate.

### Claude Desktop

```json
{
  "mcpServers": {
    "truenas": {
      "command": "npx",
      "args": ["-y", "github:truenas-connect/truenas-mcp-server#main"]
    }
  }
}
```

Or, from a local checkout: `"command": "node"`, `"args":
["/path/to/truenas-mcp-server/dist/cli.js"]`.

### MCP Inspector (quick test)

```bash
yarn build
yarn inspect            # opens the Inspector UI against node dist/cli.js
```

List the tools, call `system_info`, then try `snapshots_create` to see the
plan/confirm flow end to end (the Inspector supports elicitation).

## Confirmation flow

Mutating tools are two-phase (the core enforces this; the server cannot skip
it). How the user approval happens depends on the MCP client:

- **Client supports elicitation** — on a mutating call the server asks the
  client to prompt you with the exact plan (per-system API calls); accepting
  executes within the same call. The confirmation token never enters the
  LLM's context.
- **Fallback (no elicitation)** — the server returns the plan *and* a
  single-use, expiring token to the LLM, instructing it to present the plan
  and re-call with the token only after you approve in chat. Be clear about
  what protects you here: the token itself does **not** — it is minted before
  any approval and only binds the plan's exact arguments and target systems
  (so nothing *other* than what was shown can run). A misbehaving LLM could
  self-confirm, so on this path safety rests entirely on the host prompting
  you for every tool call. Prefer an elicitation-capable client for mutating
  operations.

Either way the token binds the exact tool, arguments, and target systems that
were planned — any drift is rejected and needs a fresh plan.

## Observing a session

To see what an MCP host (e.g. Claude Desktop) is doing with the server:

- **Tool-level**: set `auditLog` in the config — every tool execution (plan,
  execute, denial, per-system outcome) is appended as JSONL. Without it, the
  same events go to stderr, which Claude Desktop captures in
  `~/Library/Logs/Claude/mcp-server-<name>.log`.
- **Wire-level**: start the server with `--trace <path>` (or
  `TRUENAS_MCP_TRACE=<path>`) to append every JSON-RPC frame in both
  directions — `initialize`, `tools/list`, tool calls, elicitation
  round-trips:

  ```bash
  tail -f ~/.local/state/truenas-mcp/trace.jsonl | jq
  ```

Note that stdio MCP servers are one-process-per-client: the Inspector cannot
attach to the instance Claude Desktop spawned — the trace file is the way to
watch that conversation.

Startup failures print a curated message; set `TRUENAS_MCP_DEBUG=1` to get
full stack traces.

## Development

```bash
corepack enable          # once, to enable Yarn 4
yarn install             # also builds the @truenas/mcp-base git dependency
yarn build               # bundle to dist/ via tsup
yarn typecheck           # tsc --noEmit
yarn test                # vitest
yarn lint                # eslint
```

To develop against a local `truenas-mcp-base` checkout instead of the git
ref, add a resolution — do not commit it:

```json
{ "resolutions": { "@truenas/mcp-base": "portal:../truenas-mcp-base" } }
```

## Known limitations (prototype)

- Role mapping is the core's stub: every credential is treated as Full access,
  so the full catalog is advertised. Real role introspection (and role-filtered
  tool lists per system) is a core follow-up.
- Rate limiting is not implemented in the core yet.
- Credential revocation requires a server restart (config is read at startup).
