# Tests and evidence

Use node:test and node:assert/strict. Existing application tests are TypeScript;
harness fixtures are native .test.mjs and checked by tsconfig.harness.json. Both
are discovered by `pnpm test`. Keep independent synthetic fixtures and exercise
observable behavior; never populate test files with private captures or identities.

Each new sensor needs a passing control and a meaningful failing case. Confirm the
failure before implementing the rule. Do not add skips, todo/only calls, suppression
directives, or remove baseline tests to make a gate green. Changes to test names
can trigger the conservative floor; preserve names unless explicitly reviewed.

The integration suite only accepts a loopback port for fresh disposable Postgres.
Unit tests and local SQL checks do not establish hosted identity, billing or teardown
acceptance. Keep dated live evidence separate. Coverage percentages and test counts
are signals, not substitutes for meaningful assertions.
