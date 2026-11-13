# JavaScript and TypeScript contracts

Adapted from the read-only FleetIQ simulator harness. Use `/** ... */` on exported
functions/constants/default values, types/interfaces/classes, methods/accessors and
named helpers spanning six or more lines. A short constructor may rely on its class
contract. Inline callbacks normally rely on the enclosing operation's documentation.

Lead with a useful prose summary. Explain the parts names and types do not establish:

- Preconditions and trust boundaries (for example, Neon strips forged headers).
- Effects and ownership, including connection/state/stream lifetime.
- Units and bounds, expiry and retry behavior.
- Safe failure behavior and deliberate limitations.

Use `@param`, `@returns`, `@throws` or `@remarks` when useful; do not restate TypeScript
types or add empty tags. JSDoc types in .mjs tools support checkJs. Local `//` comments
explain nonobvious ordering or design decisions rather than narrating statements.

`pnpm harness` checks actual parsed declarations and attached nonempty prose in
src/, tools/ and neon.ts. Tag-only comments fail. Tests exercise missing, empty and
valid contracts. It does not validate the complete TSDoc grammar or prove prose true;
semantic accuracy belongs to review. Comments in scripts follow the same writing
standard, with mechanical backfill explicitly deferred to avoid hundreds of generic
comments over administrator code whose contracts need individual review.

The reference ESLint parser supports TypeScript below 6.1, so copying that configuration
would conflict with Berth's TypeScript 7 compiler. The isolated typescript-ast parser
is a development tool only. It must reject unparseable/new syntax rather than silently
omit it; compiler and parser compatibility should be reassessed when language pins move.
