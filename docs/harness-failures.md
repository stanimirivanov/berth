# Harness failure log

Keep entries sanitized: symptom, root cause, control and verification. Never paste
private configuration, keys, raw cloud bodies or scanner findings.

## 2026-11-13 — documentation gap and reference-tool compatibility (#29)

- **Symptom:** trial contracts lacked JSDoc/TSDoc, and prose conventions had no gate.
- **Cause:** Berth had no documentation sensor, scoped context map or canonical CI.
- **Control:** declaration-aware prose checks, positive/negative fixtures, meaningful
  trial contract documentation and the same fast/full gates locally and in CI.
- **Compatibility finding:** the reference ESLint parser requires TypeScript <6.1;
  Berth compiles with 7.0.2. TypeScript 7 does not expose the legacy JS AST API.
  The harness therefore isolates TypeScript 5.9.3 as the parser-only alias
  `typescript-ast`, with syntax-error controls; no compiler downgrade or peer bypass.
- **Environment finding:** this desktop sandbox blocks Node child-process execution
  even for local Git. The unchanged gate passed with the needed execution permission;
  that tool failure was not treated as a successful scan or worked around in code.
- **Verification:** full check passed, including 52 existing application cases,
  13 harness control cases, strict types, formatting, official ZIP build, worktree/index/
  history secret scans and dependency audit. The PostgreSQL 17 image used in CI
  also passed the real loopback permission/drift suite locally; its container was
  removed. Existing dependency findings remain seven moderate and one low.

Hosted GitHub Actions execution and external branch protection are not claimed by
local evidence. No Neon/OCI credentials were read and no cloud resources were touched
for this change. The copied reference was only read; it contains no Git metadata.

## 2026-11-13 — suppression comments around templates (#29 review)

- **Symptom:** an interpolated template could hide a later real suppression or
  make template text look like a suppression comment.
- **Cause:** a standalone scanner was not resuming template lexical context.
- **Control:** inspect leading/trailing comment ranges on parser-aligned nodes
  and tokens, deduplicated by position. Do not scan raw template bodies as code.
- **Verification:** both review reproductions became regression controls, failed
  before the change and passed after it. Source contents remain absent from diagnostics.

Final review also inverted the documentation condition: the sensor tests failed,
then passed after restoring the exact source. Staged-index secret scanning passed.
The parser alias was checked against the actual compiler executable: `tsc` remains
7.0.2. Removing comments from the four edited trial modules produced identical code.
