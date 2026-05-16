// Barrel for CLI internals. Re-exports the dispatcher, the CliContext
// factory, the prompt helpers, and the help / error renderers so
// command files (and tests) have a single import surface.
//
// This barrel is intentionally NOT re-exported from the package's
// public `src/index.ts` — every symbol here is `@internal` to the CLI
// layer and not part of the v1.0 public API.

export {main} from './index';
export {
  createCliContext,
  PROJECT_CONFIG_FILENAME,
  type CliContext,
  type CliContextOptions,
} from './cli-context';
export {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  note,
  outro,
  select,
  spinner,
  text,
  type SpinnerHandle,
} from './prompts';
export {renderError} from './render-error';
export {getVersion, renderHelp} from './help';
