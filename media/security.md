# Security configuration

The optional `security` block in `loopback.config.json` is a single place to harden the engine for CI / production runs. Every sub-section is independent and every field has a documented default that preserves pre-existing behaviour, so adding the block to an existing project is a no-op until at least one sub-key is set.

The block is validated against the generated `_meta/loopback-config.schema.json` at pipeline stage 5, so typos like `security.codegen.runTSC` fail loud with an `instancePath` pointer instead of silently being ignored.

## Reference

```jsonc
{
  "security": {
    "http": {
      "timeoutMs": 30000, // per-request timeout in ms (mitigates slowloris)
      "maxBodyBytes": 5242880, // 5 MB response cap (mitigates memory exhaustion)
      "allowPrivateHosts": false, // forbid SSRF against private/loopback IPs
      "verifyResolvedIps": true, // re-check IP after redirects (mitigates DNS rebinding)
      "allowedHosts": [], // unset = no allowlist; set = closed egress surface
      "allowRedirects": true,
      "maxRedirects": 10,
    },
    "emitters": {
      "allowProjectManifests": true, // scan <projectRoot>/emitters/*.emitter.json
      "allowedKinds": [], // unset = every discovered kind registers
    },
    "codegen": {
      "runTsc": true, // invoke `tsc --noEmit` at stage 8
      "trustedProject": true, // reserved for a future wave (engine file writes)
    },
  },
}
```

## Default profile

Everything implicit. Equivalent to omitting the `security` block entirely.

```jsonc
{
  "name": "default-app",
  "schemasDir": "./schemas",
  "configsDir": "./configs",
  "validator": "ajv",
  "schemas": ["./schemas"],
  "emit": {"zod": true, "types": true},
  // No `security` block. Defaults documented above.
}
```

## Hardened CI profile

Explicit lockdown. Tight HTTP timeouts, closed egress surface, disabled project-local emitter manifests, fixed emitter allowlist.

```jsonc
{
  "name": "hardened-ci-app",
  "schemasDir": "./schemas",
  "configsDir": "./configs",
  "validator": "ajv",
  "schemas": ["./schemas"],
  "emit": {"zod": true, "types": true},
  "security": {
    "http": {
      "timeoutMs": 10000,
      "maxBodyBytes": 1048576,
      "allowPrivateHosts": false,
      "verifyResolvedIps": true,
      "allowedHosts": ["schemas.my-org.dev"],
      "allowRedirects": false,
      "maxRedirects": 1,
    },
    "emitters": {
      "allowProjectManifests": false,
      "allowedKinds": ["zod", "types", "openapi-components"],
    },
    "codegen": {
      "runTsc": true,
      "trustedProject": true,
    },
  },
}
```

## Per-section behaviour

### `security.http.*`

Gates the engine's HTTP/HTTPS schema fetcher. Every `security.http.*` field is honored at runtime by `HttpSchemaSource`. Precedence (highest first):

1. `loopback.config.json#/security/http/<field>` (explicit per-project)
2. `LOOPBACK_CONTRACTS_<FIELD>` env var (operator override at the shell)
3. Built-in default

Env vars: `LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS`, `LOOPBACK_CONTRACTS_HTTP_MAX_BYTES`, `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS`. Prefer the config block (discoverable, reviewable); env vars are the override-from-CI escape hatch.

| Field                    | Default   | Threat mitigated                                                                                                              |
| ------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `timeoutMs`              | `30000`   | Slowloris.                                                                                                                    |
| `maxBodyBytes`           | `5242880` | Memory exhaustion from hostile or runaway remote.                                                                             |
| `allowPrivateHosts`      | `false`   | SSRF against internal services (metadata endpoints, intranet hosts).                                                          |
| `verifyResolvedIps`      | `true`    | DNS rebinding (re-resolve host after redirect chain, re-check IP).                                                            |
| `allowedHosts`           | unset     | Exfil/SSRF narrowed to known partners. When set, fetches against any other host fail loud.                                    |
| `allowRedirects`         | `true`    | Disable to forbid following 3xx redirects entirely.                                                                           |
| `maxRedirects`           | `10`      | Redirect-loop DoS, bounded DNS lookups per fetch.                                                                             |
| `allowInsecureRedirects` | `false`   | HTTPS-to-HTTP transport downgrade. Enable only for known legacy partners. Env: `LOOPBACK_CONTRACTS_ALLOW_INSECURE_REDIRECTS`. |

### `security.emitters.allowProjectManifests`

When `false`, `ManifestEmitterBooter` skips the `<projectRoot>/emitters/*.emitter.json` discovery scan (built-in manifests shipped with the plugin still register). Pin to `false` in CI to keep an attacker who can drop a `*.emitter.json` into the tree from registering a code-execution path through the template engine.

### `security.emitters.allowedKinds`

When set, every discovered manifest whose `kind` is not in the list is dropped at boot (logged under `DEBUG=loopback:contracts:manifest-emitter-booter`). Unset means every discovered kind registers.

### `security.codegen.runTsc`

When `false`, stage 8 (`tsc --noEmit`) is skipped without needing the CLI `--skip-tsc` flag. Useful when the project already runs `tsc` separately in CI. The CLI `--skip-tsc` flag remains and OR's with this setting.

### `security.codegen.trustedProject`

Reserved for a future wave that will gate engine file writes on this flag. Declared today so consumer configs can opt in early without a schema bump later.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md). Do not file security reports as public issues.
