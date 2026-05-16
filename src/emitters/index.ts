// Barrel for built-in sidecar emitters. Each export is `@experimental` until
// the v1.0 cut. Sibling agents add their own emitters by appending to this
// list — never re-order existing entries (the order is the deterministic
// stable-sort tie-breaker the runner relies on for snapshot diffs).

export {OpenAPIComponentsEmitter} from './openapi-components-emitter';
export {TypesEmitter} from './types-emitter';
export {ZodEmitter} from './zod-emitter';
export {GraphQLEmitter} from './graphql-emitter';
export {CloudEventsEmitter} from './cloudevents-emitter';
export {AsyncAPIEmitter} from './asyncapi-emitter';
export {ProtoEmitter} from './proto-emitter';
export {AvroEmitter} from './avro-emitter';
export {MockDataEmitter} from './mock-data-emitter';
