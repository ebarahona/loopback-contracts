// Barrel for built-in sidecar emitters. Each export is `@experimental` until
// the v1.0 cut. Sibling agents add their own emitters by appending to this
// list — never re-order existing entries (the order is the deterministic
// stable-sort tie-breaker the runner relies on for snapshot diffs).

// Built-in manifest emitters discovered by `ManifestEmitterBooter` at
// runtime (no TS export needed): `cloudevents` (under
// `src/emitters/manifest/cloudevents/`), `openapi-components` (under
// `src/emitters/manifest/openapi-components/`).

export {TypesEmitter} from './library/types-emitter';
export {ZodEmitter} from './library/zod-emitter';
export {MockDataEmitter} from './library/mock-data-emitter';

export {GraphQLEmitter} from './semantic/graphql-emitter';
export {AsyncAPIEmitter} from './semantic/asyncapi-emitter';
export {ProtoEmitter} from './semantic/proto-emitter';
export {AvroEmitter} from './semantic/avro-emitter';
