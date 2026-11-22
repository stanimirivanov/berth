# Berth

Use the installed **mattpocock/skills** as the primary engineering workflow for
planning, triage, implementation, TDD and review. Use the repository contracts
below for technical requirements and the owner's instructions for task scope.

## Agent skills

- **Issue tracker** — GitHub Issues via `gh`. See [issue tracker](docs/agents/issue-tracker.md).
- **Triage labels** — Five canonical roles. See [triage labels](docs/agents/triage-labels.md).
- **Domain docs** — One Berth domain context. See [domain docs](docs/agents/domain.md).

## Technical contracts

- [SPEC.md](SPEC.md) defines the trial, evidence and authorization boundaries.
  Local verification uses synthetic fixtures and does not authorize cloud operations.
- [CONSTRAINTS.md](CONSTRAINTS.md) defines the quality floor.
  [HARNESS.md](HARNESS.md) defines source style, verification gates and setup.
  Run the affected checks and `pnpm check:fast` and `pnpm check` before delivery.
- [Comment quality](docs/comment-quality.md) defines the JSDoc/TSDoc contract.
- Backend and verification use pinned Node 24, pnpm and TypeScript 7.
  Angular in [ui/](ui/README.md) has its own lockfile and TypeScript 6 compiler.
- Keep credentials out of source, command arguments, logs, test fixtures and
  GitHub evidence. Preserve unrelated work and avoid destructive Git operations.

| Area | Scoped technical guide |
| --- | --- |
| Hosted trial and history service | [src/trial](src/trial/AGENTS.md) |
| OCI provider | [src/providers/oci](src/providers/oci/AGENTS.md) |
| Administrator and build commands | [scripts](scripts/AGENTS.md) |
| Tests and fixtures | [tests](tests/AGENTS.md) |
| Verification tools and CI | [tools](tools/AGENTS.md) |
