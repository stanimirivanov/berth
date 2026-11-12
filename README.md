# Berth

A planned single-user hosted application for provisioning and monitoring cloud
resources within free-tier allowances. The first slice is an OCI Object Storage
trial on Neon Free. This repository currently provides the offline trial toolchain;
it has no deployed application or live cloud validation.

## Local toolchain

Use **Node 24.22.3** and its bundled **npm 11.19.1**. With nvm installed:

```sh
nvm install
nvm use
npm ci
npm run typecheck
npm run lint
npm run test:smoke
```

Without nvm, install the exact version from [Node's official distribution](https://nodejs.org/dist/v24.22.3/).
`.npmrc` rejects incompatible engines, saves exact versions and disables dependency
install scripts. `package-lock.json` is the only dependency lockfile. No cloud
credentials are needed for installation, compilation or tests.

| Command | Behavior |
|---|---|
| `npm ci` | Clean locked dependency install, with dependency scripts disabled |
| `npm run build` | Compile strict TypeScript tests into ignored `dist/` |
| `npm run typecheck` | Check TypeScript, including dependency declarations, without emitting |
| `npm run lint` | Check test code and tool configuration with Biome |
| `npm test` | Build and run all current tests with Node's built-in test runner |
| `npm run test:smoke` | Build and run only the runtime compatibility smoke tests |
| `npm run neon -- --version` | Inspect the pinned local Neon CLI without logging in |

The tests round-trip Alchemy in-memory state through Effect and cryptographically
verify OCI signing with an ephemeral test key. They perform no cloud operations
and do not prove Neon deployment, durable state, IAM permissions or provisioning.
There is no deployment command or account bootstrap in this slice.

## Exact direct pins

| Component | Version |
|---|---|
| Node / npm / Node test runner | 24.22.3 / 11.19.1 / bundled with Node |
| Alchemy | 2.0.0-beta.86 |
| Effect / Effect Node platform | 4.1.4 / 4.1.4 |
| OCI common / Object Storage SDK | 2.146.0 / 2.146.0 |
| Neon CLI | 9.4.0 |
| TypeScript / Biome | 7.0.2 / 2.6.7 |
| Node / node-fetch / React declarations | 24.19.2 / 2.6.13 / 19.3.0 |

Alchemy's public declarations reference React and OCI's reference node-fetch, so
those type packages are required even though Berth has no React UI. Alchemy is a
beta; the pins and smoke checks establish only this tested local combination.
See [dependency audit notes](docs/toolchain-audit.md) for current CLI advisories.

## Project inputs

- [Approved trial specification](SPEC.md)
- [Account setup and permissions](docs/oci-neon-setup.md)
- [Implementation plan and GitHub issue index](tasks/plan.md)
- [Issue and PR workflow](AGENTS.md)

Hosting must use free plans and operate without the owner's computer online.
Cloudflare frontend hosting and Neon execution remain conditional on feasibility.
Keep `.env*`, private keys, `.oci/`, `.neon`, and `.alchemy/` out of Git. Only
placeholder `.env.example` files may be tracked. Never paste real credentials into
issues, PRs, command arguments, logs or test fixtures.
