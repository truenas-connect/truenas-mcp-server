/**
 * The shape of a tool result body, in one place.
 *
 * `resultsText` in `src/server.ts` renders a RESULTS outcome as an optional
 * human-facing prefix, the per-system results as a pretty-printed JSON block,
 * and — the first time a tool answers in a session — the tool's result
 * guidance after a blank line. Both the tier-0/1 spec and the tier-2 dist spec
 * need to pull the block back out of that, and the rules for doing it safely
 * are a contract with that renderer rather than anything obvious:
 *
 * - the block is found by its own shape: its '[' and ']' each start a line, or
 *   it is the single line '[]'. Never "the first [" or "the rest of the text",
 *   which would couple parsing to both surrounding prose blocks staying
 *   bracket-free — and neither is true. Guidance may open a line with '[', and
 *   a nested empty array inside a value puts ']' well before the block's close.
 * - `end` is exposed because ordering assertions need it. Re-deriving it with
 *   `search(/^\]/m)` returns -1 for the single-line '[]' block, and any
 *   "guidance comes after the data" check then passes against -1 without
 *   comparing anything.
 *
 * Duplicating that in two spec files made the contract two copies that could
 * drift apart on the next change to the separator or the prefix.
 */
const RESULTS_BLOCK = /^(?:\[\]|\[[\s\S]*?^\])/m;

/** The results block's JSON, and the index just past its closing bracket. */
export function resultsBlock(body: string): { json: string; end: number } {
  const match = RESULTS_BLOCK.exec(body);
  if (match === null) {
    throw new Error(`No results block in tool result body:\n${body}`);
  }
  return { json: match[0], end: match.index + match[0].length };
}
