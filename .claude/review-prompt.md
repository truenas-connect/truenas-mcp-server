Please review the changes and provide comprehensive feedback.

Focus on:
- Code quality and best practices
- Maintainability, good architecture design and patterns
- Adherence to project conventions
- Potential bugs or issues
- Performance considerations
- Security implications

This is the standalone (community) TrueNAS MCP server: the stdio adapter that
wires the shared `@truenas/mcp-base` core (tool catalog, system registry,
plan/confirm safety model, multi-system fan-out) to an MCP host, a local
config file, and local audit sinks. Pay particular attention to:
- Confirmation-gate contract: `ConfirmationService.mint` may only be called
  after a real user approval — through the elicitation gate, or the documented
  fallback path. The server must never execute a mutating tool without a
  token, and safety decisions must never be delegated to the LLM.
- Protocol hygiene: stdout is the MCP channel — nothing but protocol traffic
  may ever be written to it; all human-facing output goes to stderr.
- Credential hygiene: the config file holds API keys — file-permission
  handling matters, and keys must never leak into logs, tool results, audit
  events, or error messages.
- Error surfacing: tool failures must come back as structured,
  LLM-interpretable `isError` content rather than crashes; startup and CLI
  failures need clear human-readable messages and correct exit codes.
- Interactive flows: `init` must behave correctly with both TTY and piped
  input (buffered answers, masked secrets, validation re-prompts).
- Async correctness: unhandled promise rejections, missing `await`, and race
  conditions; timers and timeouts must be cleaned up.
- Resource lifecycle: API clients and the registry must be closed on shutdown
  and on error paths; nothing should keep the process alive after the
  transport closes.
- Type safety: avoid `any`, prefer precise types, and keep the exported API
  surface consistent with the core's conventions.

Do not provide:
- summary of what PR does
- list of steps you took to review
- numeric rating or score

When describing positive aspects of the PR, just mention them briefly in one - three sentences.

Ignore small nit-picky issues like formatting or style unless they significantly impact readability.

Provide constructive feedback with specific suggestions for improvement.
Use inline comments to highlight specific areas of concern.

Some common pitfalls to watch for:
- Fixing an issue in a specific place without considering other places or overall architecture.
- Leaving in unused code.
- Missing or inadequate test coverage for new behavior.
- Writing tests that interact with methods that should be private or protected.

Use an enthusiastic and positive tone, you can use some emojis.

Keep review brief and focused:
- do not repeat yourself
- keep overall assessment concise (one sentence)
