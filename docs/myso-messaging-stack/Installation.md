# Installation

## Contents

- [Install from npm](#install-from-npm)
- [Peer Dependency Versions](#peer-dependency-versions)
- [Requirements](#requirements)
- [Build from Source](#build-from-source)
- [Smart Contracts](#smart-contracts)
- [Relayer](#relayer)

---

## Install from npm

```bash
pnpm add @socialproof/myso-messaging-stack @socialproof/myso-groups @socialproof/mydata @socialproof/myso @socialproof/bcs
```

The last four are peer dependencies. If your project already depends on them (most MySo dApps do), you only need:

```bash
pnpm add @socialproof/myso-messaging-stack @socialproof/myso-groups
```

### Peer Dependency Versions

| Package | Minimum version |
| --- | --- |
| `@socialproof/myso-groups` | \* |
| `@socialproof/mydata` | ^0.0.4 |
| `@socialproof/myso` | ^0.0.4 |
| `@socialproof/bcs` | ^0.0.4 |

## Requirements

- Node.js >= 22
- pnpm >= 10.17.0

## Build from Source

```bash
git clone https://github.com/the-social-proof-foundation/myso-messaging-stack.git
cd myso-messaging-stack/ts-sdks
pnpm install
pnpm build
```

## Smart Contracts

The messaging Move package is pre-deployed on **testnet and on mainnet**. The SDK auto-detects the correct package IDs based on the client's network.

For localnet or custom deployments, you must deploy both the `myso_groups` and `myso_messaging` packages (`myso_messaging` depends on `myso_groups`). Refer to the [MySo Groups Installation guide](https://github.com/the-social-proof-foundation/myso-groups) for deploying the base package first, then deploy the messaging package on top.

Provide a `packageConfig` when instantiating the client to point at your custom deployment. See [Setup](./Setup.md) for details.

## Relayer

The SDK communicates with an off-chain relayer for message storage and delivery. See [Relayer](./Relayer.md) for integration details and the [relayer README](../../relayer/README.md) for running the reference implementation.
