import { describe, expect, it } from 'vitest';
import { resultsBlock } from './results';

/**
 * The contract this helper holds is with `resultsText` in `src/server.ts`, and
 * two of its cases are unreachable through the specs that use it: a fan-out
 * always yields one entry per targeted system, so no real body carries an
 * empty block, and no real prefix contains a bracket. Those are exactly the
 * cases the shape rules exist for, so they are exercised here directly rather
 * than left to a body no caller can produce.
 */
describe('resultsBlock', () => {
  const guidance = '\n\nHow to read x results (sent once per session):\n[a] then [b]';

  it.each([
    ['a bare block', '[\n  { "system": "a" }\n]', [{ system: 'a' }]],
    ['a block then guidance', `[\n  { "system": "a" }\n]${guidance}`, [{ system: 'a' }]],
    [
      'a prefix, a block, and guidance',
      `Approved by the user in the client UI.\n[\n  { "system": "a" }\n]${guidance}`,
      [{ system: 'a' }],
    ],
    // The -1 hazard: `search(/^\]/m)` finds nothing here, so any hand-rolled
    // "guidance comes after the data" check compares against -1 and passes
    // without comparing anything.
    ['an empty block', '[]', []],
    ['an empty block then guidance', `[]${guidance}`, []],
    // A nested empty array puts the first `]` well before the block's close,
    // which is why the close is located by line and not by `indexOf`.
    [
      'a nested empty array inside a value',
      '[\n  {\n    "value": {\n      "failures": []\n    }\n  }\n]',
      [{ value: { failures: [] } }],
    ],
  ])('parses %s', (_name, body, expected) => {
    const block = resultsBlock(body);
    expect(JSON.parse(block.json)).toEqual(expected);
    // `end` is the index just past the block. `tests/stdio.spec.ts` compares
    // the guidance heading's position against it with `toBe`, so an off-by-one
    // here would silently weaken that assertion into an adjacent one.
    expect(body.slice(block.end - block.json.length, block.end)).toBe(block.json);
    // And what follows is either nothing or the separator the server writes
    // between the data and the guidance — never a trailing fragment of block.
    expect(body.slice(block.end)).toMatch(/^(?:$|\n\nHow to read )/);
  });

  it('throws rather than guessing when there is no block', () => {
    expect(() => resultsBlock('Mutating tools are disabled for this client.')).toThrow(
      /No results block/,
    );
  });

  // The anchoring case. Unanchored, `^\[\]` matches the earliest line that
  // merely BEGINS with `[]` — here a prose line — and returns a clean empty
  // array: a confident wrong answer in place of a loud failure. Anchored, the
  // body falls through to the block alternative and fails to parse.
  it('does not mistake a prefix line beginning with [] for an empty block', () => {
    const body = 'Note:\n[] see below\n[\n  { "system": "a" }\n]';
    const { json } = resultsBlock(body);
    expect(json).not.toBe('[]');
    expect(() => JSON.parse(json)).toThrow();
  });
});
