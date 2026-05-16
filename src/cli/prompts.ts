// Thin facade over `@clack/prompts` exposing strongly-typed helpers the
// command files consume. Centralising the wrapper lets command files
// stay decoupled from the underlying prompt library and gives us one
// place to translate user-cancel into a typed exit-code 130 error.
//
// Defensive fallback: if `@clack/prompts` cannot be loaded at runtime
// (e.g. tree-shaken out or installed as a missing optional dep), the
// helpers drop down to a minimal `node:readline` implementation that
// covers the same surface — no colours, no spinners.

import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {ContractsError} from '../helpers';

// Lazy CommonJS require for `@clack/prompts` — kept lazy so a missing
// optional dep falls through to the readline fallback below. `createRequire`
// keeps the call site free of the lint-banned `require()` global.
const requireFromHere = createRequire(__filename);

/**
 * Loose, structural view of the `@clack/prompts` surface this wrapper
 * relies on. Using a structural shape keeps us forward-compatible with
 * future clack releases that add fields, and lets the fallback impl
 * satisfy the same interface without depending on the upstream types.
 *
 * @internal
 */
interface ClackPrompts {
  text(opts: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    initialValue?: string;
    validate?: (v: string) => string | Error | undefined;
  }): Promise<string | symbol>;
  select<T>(opts: {
    message: string;
    options: {label?: string; value: T; hint?: string}[];
    initialValue?: T;
  }): Promise<T | symbol>;
  multiselect<T>(opts: {
    message: string;
    options: {label?: string; value: T; hint?: string}[];
    initialValues?: T[];
    required?: boolean;
  }): Promise<T[] | symbol>;
  confirm(opts: {
    message: string;
    initialValue?: boolean;
  }): Promise<boolean | symbol>;
  isCancel(v: unknown): v is symbol;
  intro(text?: string): void;
  outro(text?: string): void;
  note(message?: string, title?: string): void;
  cancel(text?: string): void;
  spinner(): SpinnerHandle;
}

/**
 * Spinner control returned by {@link spinner}. Mirrors the clack
 * spinner shape exactly so consumers don't have to learn a new API.
 *
 * @public
 */
export interface SpinnerHandle {
  start(msg?: string): void;
  stop(msg?: string, code?: number): void;
  message(msg?: string): void;
}

let cachedImpl: ClackPrompts | undefined;

function loadImpl(): ClackPrompts {
  if (cachedImpl !== undefined) return cachedImpl;
  try {
    const mod = requireFromHere('@clack/prompts') as ClackPrompts;
    cachedImpl = mod;
    return mod;
  } catch {
    cachedImpl = buildFallback();
    return cachedImpl;
  }
}

const FALLBACK_CANCEL = Symbol('lb-contracts.fallback.cancel');

function buildFallback(): ClackPrompts {
  const ask = (prompt: string): Promise<string> =>
    new Promise(resolve => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      rl.question(prompt, ans => {
        rl.close();
        resolve(ans);
      });
    });
  return {
    async text(opts) {
      const def =
        opts.defaultValue !== undefined ? ` (${opts.defaultValue})` : '';
      const ans = await ask(`? ${opts.message}${def}: `);
      const v = ans.length > 0 ? ans : (opts.defaultValue ?? '');
      if (opts.validate !== undefined) {
        const result = opts.validate(v);
        if (result !== undefined) {
          return FALLBACK_CANCEL;
        }
      }
      return v;
    },
    async select<T>(opts: {
      message: string;
      options: {label?: string; value: T; hint?: string}[];
    }): Promise<T | symbol> {
      const list = opts.options
        .map((o, i) => `  ${i + 1}) ${o.label ?? String(o.value)}`)
        .join('\n');
      const ans = await ask(`? ${opts.message}\n${list}\n> `);
      const idx = Number.parseInt(ans, 10) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= opts.options.length) {
        return FALLBACK_CANCEL;
      }
      return opts.options[idx]!.value;
    },
    async multiselect<T>(opts: {
      message: string;
      options: {label?: string; value: T; hint?: string}[];
      initialValues?: T[];
    }): Promise<T[] | symbol> {
      const list = opts.options
        .map((o, i) => `  ${i + 1}) ${o.label ?? String(o.value)}`)
        .join('\n');
      const ans = await ask(
        `? ${opts.message} (comma-separated numbers)\n${list}\n> `,
      );
      if (ans.length === 0) return opts.initialValues ?? [];
      const picked: T[] = [];
      for (const part of ans.split(',')) {
        const idx = Number.parseInt(part.trim(), 10) - 1;
        if (Number.isNaN(idx) || idx < 0 || idx >= opts.options.length) {
          return FALLBACK_CANCEL;
        }
        picked.push(opts.options[idx]!.value);
      }
      return picked;
    },
    async confirm(opts) {
      const def = opts.initialValue === false ? 'N' : 'Y';
      const ans = await ask(`? ${opts.message} [${def}]: `);
      if (ans.length === 0) return opts.initialValue !== false;
      return /^y(es)?$/i.test(ans);
    },
    isCancel(v): v is symbol {
      return v === FALLBACK_CANCEL;
    },
    intro(text) {
      if (text !== undefined) process.stderr.write(`${text}\n`);
    },
    outro(text) {
      if (text !== undefined) process.stderr.write(`${text}\n`);
    },
    note(message, title) {
      if (title !== undefined) process.stderr.write(`${title}\n`);
      if (message !== undefined) process.stderr.write(`${message}\n`);
    },
    cancel(text) {
      if (text !== undefined) process.stderr.write(`${text}\n`);
    },
    spinner() {
      return {
        start(msg) {
          if (msg !== undefined) process.stderr.write(`${msg}...\n`);
        },
        stop(msg) {
          if (msg !== undefined) process.stderr.write(`${msg}\n`);
        },
        message(msg) {
          if (msg !== undefined) process.stderr.write(`${msg}\n`);
        },
      };
    },
  };
}

/**
 * Throw a typed exit-code-130 error when the user cancelled. Centralised
 * so every prompt helper raises the same error shape — the dispatcher
 * recognises this code and exits cleanly without rendering a stack.
 *
 * @internal
 */
function throwCancelled(): never {
  throw new ContractsError('CONTRACTS_CLI_CANCELLED', 'Cancelled by user');
}

/**
 * Free-form text input. Resolves to the user's response (or the default
 * when they pressed enter on an empty prompt). Throws a cancelled error
 * if the user pressed Ctrl+C.
 *
 * @public
 */
export async function text(opts: {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  validate?: (v: string) => string | Error | undefined;
}): Promise<string> {
  const impl = loadImpl();
  const passthrough: Parameters<ClackPrompts['text']>[0] = {
    message: opts.message,
  };
  if (opts.placeholder !== undefined)
    passthrough.placeholder = opts.placeholder;
  if (opts.defaultValue !== undefined) {
    passthrough.defaultValue = opts.defaultValue;
    passthrough.initialValue = opts.defaultValue;
  }
  if (opts.validate !== undefined) passthrough.validate = opts.validate;
  const result = await impl.text(passthrough);
  if (impl.isCancel(result)) throwCancelled();
  return result as string;
}

/**
 * Single-pick list of typed options. The return type is whatever the
 * caller annotated `T` as — the wrapper preserves it across the clack
 * boundary.
 *
 * @public
 */
export async function select<T>(opts: {
  message: string;
  options: {label: string; value: T; hint?: string}[];
  initialValue?: T;
}): Promise<T> {
  const impl = loadImpl() as unknown as {
    select(o: unknown): Promise<unknown>;
    isCancel(v: unknown): v is symbol;
  };
  const passthrough: {
    message: string;
    options: {label: string; value: T; hint?: string}[];
    initialValue?: T;
  } = {message: opts.message, options: opts.options};
  if (opts.initialValue !== undefined)
    passthrough.initialValue = opts.initialValue;
  const result = await impl.select(passthrough);
  if (impl.isCancel(result)) throwCancelled();
  return result as T;
}

/**
 * Multi-pick list of typed options. Returns the picked subset preserving
 * the input ordering. Empty selection is allowed.
 *
 * @public
 */
export async function multiselect<T>(opts: {
  message: string;
  options: {label: string; value: T; hint?: string}[];
  initialValues?: T[];
  required?: boolean;
}): Promise<T[]> {
  const impl = loadImpl() as unknown as {
    multiselect(o: unknown): Promise<unknown>;
    isCancel(v: unknown): v is symbol;
  };
  const passthrough: {
    message: string;
    options: {label: string; value: T; hint?: string}[];
    initialValues?: T[];
    required: boolean;
  } = {
    message: opts.message,
    options: opts.options,
    required: opts.required === true,
  };
  if (opts.initialValues !== undefined)
    passthrough.initialValues = opts.initialValues;
  const result = await impl.multiselect(passthrough);
  if (impl.isCancel(result)) throwCancelled();
  return result as T[];
}

/**
 * Yes/no confirmation. Defaults to `true` unless `initialValue` says
 * otherwise.
 *
 * @public
 */
export async function confirm(opts: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  const impl = loadImpl();
  const passthrough: Parameters<ClackPrompts['confirm']>[0] = {
    message: opts.message,
  };
  if (opts.initialValue !== undefined)
    passthrough.initialValue = opts.initialValue;
  const result = await impl.confirm(passthrough);
  if (impl.isCancel(result)) throwCancelled();
  return result as boolean;
}

/**
 * Factory returning a fresh spinner handle. Caller controls `start`,
 * `stop`, and intermediate `message` updates.
 *
 * @public
 */
export function spinner(): SpinnerHandle {
  return loadImpl().spinner();
}

/**
 * Print the prompt-session header.
 *
 * @public
 */
export function intro(text: string): void {
  loadImpl().intro(text);
}

/**
 * Print the prompt-session footer.
 *
 * @public
 */
export function outro(text: string): void {
  loadImpl().outro(text);
}

/**
 * Print a framed informational note.
 *
 * @public
 */
export function note(text: string, title?: string): void {
  loadImpl().note(text, title);
}

/**
 * Print the standard cancel banner. The CLI dispatcher uses this when
 * an outer flow needs to bail without throwing.
 *
 * @public
 */
export function cancel(text: string): void {
  loadImpl().cancel(text);
}

/**
 * Predicate identifying clack's internal cancel symbol. Re-exported so
 * legacy command code written against the raw clack return shape (which
 * was `T | symbol`) still type-checks. New code should rely on the
 * typed helpers above, which throw a {@link ContractsError} on cancel
 * before the symbol is ever returned — this predicate then always
 * evaluates to `false` from a caller's perspective.
 *
 * @public
 */
export function isCancel(v: unknown): v is symbol {
  return loadImpl().isCancel(v);
}
