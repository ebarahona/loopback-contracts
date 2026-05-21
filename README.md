# @ebarahona/loopback-contracts

[![npm version](https://img.shields.io/npm/v/@ebarahona/loopback-contracts.svg)](https://www.npmjs.com/package/@ebarahona/loopback-contracts)
[![CI](https://img.shields.io/github/actions/workflow/status/ebarahona/loopback-contracts/ci.yml?branch=main&label=ci)](https://github.com/ebarahona/loopback-contracts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@ebarahona/loopback-contracts.svg)](./LICENSE)

A contract-first codegen plugin for LoopBack 4.

## Overview

`@ebarahona/loopback-contracts` consumes JSON Schema 2020-12 from a local directory, a remote source (`npm:`, `git+`, `https://`), or an interactive CLI wizard. The engine emits LoopBack 4 models, repositories, controllers, datasources, an OpenAPI 3.1 document, and opt-in sidecar formats (Zod, TypeScript types, GraphQL, AsyncAPI, Protocol Buffers, Avro, OpenAPI components, CloudEvents, mock data). All generated artifacts register with LoopBack 4's runtime DI container the moment they land on disk.

### Contract-first

JSON Schema 2020-12 is the canonical source. Every output, the LoopBack 4 classes, the OpenAPI 3.1 document, and every sidecar format, derives from one schema file. When the schema changes, every projection regenerates from the next `lb-contracts gen`. The OpenAPI 3.1 document is served live by the LB4 app at `GET /openapi.json`, so the generated REST surface and the contract cannot drift.

### Runtime dependency injection

LoopBack 4 is the only Node framework with first-class runtime DI: extension points, lifecycle observers, context-based dependency resolution, hot-swappable bindings. This plugin treats the generated `@model`, `@repository`, `@controller`, and datasource classes as DI citizens from day one. Swap a datasource at runtime without regenerating. Decorate a controller with extra interceptors. The contracts you author and the bindings you wire stay independent forever.

## Installation

```bash
npm install @ebarahona/loopback-contracts
```

LoopBack 4 itself is a peer dependency:

```bash
npm install @loopback/core @loopback/repository @loopback/rest
```

Optional output formats load their generators lazily. Install only the libraries for the formats the project actually emits:

| Format               | Install                                 |
| -------------------- | --------------------------------------- |
| Zod validators       | `npm install zod json-schema-to-zod`    |
| TypeScript types     | `npm install json-schema-to-typescript` |
| GraphQL SDL          | `npm install quicktype-core`            |
| Protocol Buffers     | `npm install quicktype-core`            |
| Avro records         | `npm install quicktype-core`            |
| CloudEvents wrappers | `npm install cloudevents`               |
| Mock data fixtures   | `npm install json-schema-faker`         |
| AsyncAPI YAML        | (no extra install)                      |
| OpenAPI components   | (no extra install)                      |

Enabling an emit flag without its generator installed fails fast with a named package and an install command.

### Requirements

- Node.js >= 20.19.0
- A LoopBack 4 application. The generated bases compile standalone against `@loopback/core` + `@loopback/repository` if the project is non-LB4, but the runtime DI integration assumes a LoopBack 4 host.

## Basic use

```bash
lb-contracts init                          # writes loopback.config.json
lb-contracts ds primary --adapter memory   # declares a datasource
lb-contracts contract order                # writes schemas/order.schema.json + configs/order.config.json
lb-contracts gen                           # walks the validation pipeline and emits all artifacts
```

`lb-contracts gen` runs the eight-stage validation pipeline (JSON Schema 2020-12 -> OpenAPI 3.1 -> LoopBack 4 model / repository / controller / datasource) and writes regen-always `.base.*` files alongside user-owned extension files (scaffolded via `lb-contracts override`). The `$schema` pointer at the top of every authored JSON file resolves to a project-specific meta-schema the engine regenerates, so VS Code autocompletes valid datasource names, contract ids, relation kinds, and ACL shapes inline.

## Related resources

- [docs/cli.md](./docs/cli.md) — full CLI command reference (fifteen subcommands).
- [docs/architecture.md](./docs/architecture.md) — eight-stage validation pipeline, schema sources, extension points, project layout, stability and semver policy.
- [docs/emitters.md](./docs/emitters.md) — output format catalog, lossy-translation reports, and the two emitter contribution paths.
- [docs/security.md](./docs/security.md) — security configuration for CI / production (SSRF guards, DNS-rebinding protection, host allowlist, emitter sandbox).
- [`loopback-contracts.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/loopback-contracts.md) — full architectural reference (umbrella project).
- [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md) — extensibility reference (umbrella project).
- [`@ebarahona/loopback-contracts-import`](https://github.com/ebarahona/loopback-contracts-import) — sibling plugin covering the inverse direction (Zod, OpenAPI, WSDL, Avro, proto, GraphQL SDL, AsyncAPI, or live database -> `schemas/*.schema.json`).
- API reference (TypeDoc): https://ebarahona.github.io/loopback-contracts

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md), [AGENTS.md](./AGENTS.md), and [STYLE_GUIDE.md](./STYLE_GUIDE.md). Open contribution slots: [HELP_WANTED.md](./HELP_WANTED.md).

## License

MIT
