# Berth

A planned single-user hosted application for provisioning and monitoring cloud
resources within free-tier allowances. The first slice is an OCI Object Storage
trial on Neon Free. This repository provides the trial toolchain and an opt-in
Neon database bootstrap plus OCI policy/read-only verification tooling. Neon
database permissions have owner-reported live verification; hosted execution and
OCI live readiness remain pending.

## Local toolchain

Use **Node 24.22.3** and **pnpm 12.16.1**. With nvm and pnpm installed:

```sh
nvm install
nvm use
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run test:smoke
```

The `packageManager` field selects pnpm 12.16.1; an existing modern pnpm can
download that version automatically. npm is not required. If pnpm is missing,
use its [standalone installation instructions](https://pnpm.io/installation).

Without nvm, install the exact version from [Node's official distribution](https://nodejs.org/dist/v24.22.3/).
`pnpm-workspace.yaml` rejects incompatible engines, saves exact versions and disables
install scripts. `pnpm-lock.yaml` is the only dependency lockfile. No cloud
credentials are needed for installation, compilation or tests.

| Command | Behavior |
|---|---|
| `pnpm install --frozen-lockfile` | Install the locked dependency graph, with dependency scripts disabled |
| `pnpm run build` | Compile strict TypeScript scripts/tests into ignored `dist/` |
| `pnpm run typecheck` | Check TypeScript, including dependency declarations, without emitting |
| `pnpm run lint` | Check script/test code and tool configuration with Biome |
| `pnpm test` | Build and run offline tests with Node's built-in test runner |
| `pnpm run test:smoke` | Build and run only the runtime compatibility smoke tests |
| `pnpm run neon --version` | Inspect the pinned local Neon CLI without logging in |
| `pnpm run setup:oci-admin --help` | Show administrator setup and rejected-user recovery (existing Default domain) |
| `pnpm run setup:oci --help` | Show offline OCI policy generation and read-only verification commands |
| `pnpm run test:oci-setup` | Run focused offline OCI setup tests |
| `pnpm run setup:neon --help` | Show the opt-in Neon setup command |
| `pnpm run test:setup-db` | Test real permissions in an explicitly configured disposable local PostgreSQL database |

The tests round-trip Alchemy in-memory state through Effect and cryptographically
verify OCI signing with an ephemeral test key. They perform no cloud operations
and do not prove Neon deployment, durable state, IAM permissions or provisioning.
The separate [Neon setup guide](docs/neon-bootstrap.md) walks through preview,
apply and permission verification. Its live commands require an owner API key
stored privately outside the repository. No deployment or schedule is created.

## Exact direct pins

| Component | Version |
|---|---|
| Node / pnpm / Node test runner | 24.22.3 / 12.16.1 / bundled with Node |
| Alchemy | 2.0.0-beta.86 |
| Effect / Effect Node platform | 4.1.4 / 4.1.4 |
| OCI common / Object Storage SDK | 2.146.0 / 2.146.0 |
| Neon CLI | 9.4.0 |
| TypeScript / Biome | 7.0.2 / 2.6.7 |
| Node / node-fetch / React declarations | 24.19.2 / 2.6.13 / 19.3.0 |
| PostgreSQL setup driver / declarations | 8.23.1 / 8.23.1 |

Alchemy's public declarations reference React and OCI's reference node-fetch, so
those type packages are required even though Berth has no React UI. Alchemy is a
beta; the pins and smoke checks establish only this tested local combination.
See [dependency audit notes](docs/toolchain-audit.md) for current CLI advisories.

## Project inputs

- [Approved trial specification](SPEC.md)
- [Account setup and permissions](docs/oci-neon-setup.md)
- [Restricted OCI identity setup](docs/oci-bootstrap.md)
- [Implementation plan and GitHub issue index](tasks/plan.md)
- [Issue and PR workflow](AGENTS.md)

Hosting must use free plans and operate without the owner's computer online.
Cloudflare frontend hosting and Neon execution remain conditional on feasibility.
Keep `.env*`, private keys, `.oci/`, `.neon`, and `.alchemy/` out of Git. Only
placeholder `.env.example` files may be tracked. Never paste real credentials into
issues, PRs, command arguments, logs or test fixtures.

OCI diagnostics: see [the read-only doctor guide](docs/oci-doctor.md) for `pnpm run doctor:oci`, optional OCI CLI comparison and agent-operated verification.
