// User-facing error rendering for the CLI dispatcher. Pure formatter:
// takes any thrown value, returns a multi-line string ready for stderr.
// No I/O. ANSI colours auto-disable for non-TTY / `NO_COLOR`.

import {
  ContractsCodegenError,
  ContractsEmitterConflictError,
  ContractsError,
  ContractsPeerDepMissingError,
  ContractsPipelineError,
  ContractsSourceError,
  ContractsValidationError,
} from '../helpers';

/**
 * Inline ANSI colour helper. Each tag returns the input wrapped in the
 * named escape sequence, or the input unchanged when colours are
 * disabled (NO_COLOR env var set, or stdout is not a TTY).
 *
 * @internal
 */
interface AnsiTagger {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

function colorsEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }
  return process.stdout.isTTY === true;
}

function ansi(): AnsiTagger {
  const on = colorsEnabled();
  const wrap = (code: string, s: string): string =>
    on ? `[${code}m${s}[0m` : s;
  return {
    bold: s => wrap('1', s),
    dim: s => wrap('2', s),
    red: s => wrap('31', s),
    yellow: s => wrap('33', s),
    cyan: s => wrap('36', s),
  };
}

/**
 * One sub-error from a `ContractsValidationError.cause` array, when the
 * cause was an array of Ajv errors aggregated into a single throw. The
 * shape is intentionally loose so callers can pass either raw Ajv errors
 * or a normalised projection.
 *
 * @internal
 */
interface ChildValidationError {
  message?: string;
  instancePath?: string;
  schemaPath?: string;
}

function isChildValidationErrorArray(
  cause: unknown,
): cause is ChildValidationError[] {
  return (
    Array.isArray(cause) &&
    cause.every(
      e =>
        typeof e === 'object' &&
        e !== null &&
        ('message' in e || 'instancePath' in e),
    )
  );
}

/**
 * Format any thrown value into a user-facing error block. ContractsError
 * subclasses produce structured output (title, file, instancePath,
 * hint); foreign throws fall back to `String(err)`.
 *
 * @param err - The thrown value to format.
 * @returns Multi-line string with trailing newline.
 *
 * @public
 */
export function renderError(err: unknown): string {
  const c = ansi();
  const lines: string[] = [];

  if (err instanceof ContractsError) {
    lines.push(`${c.red(c.bold('error'))} ${c.bold(`[${err.code}]`)}`);
    lines.push(`  ${err.message}`);

    if (err instanceof ContractsValidationError) {
      lines.push(`  ${c.dim('file:')}   ${err.sourcePath}`);
      lines.push(`  ${c.dim('at:')}     ${err.instancePath || '/'}`);
      if (err.schemaId !== undefined) {
        lines.push(`  ${c.dim('schema:')} ${err.schemaId}`);
      }
      const children = (err as {cause?: unknown}).cause;
      if (isChildValidationErrorArray(children) && children.length > 0) {
        lines.push('');
        lines.push(`  ${c.bold(`${children.length} validation error(s):`)}`);
        for (const child of children) {
          const at = child.instancePath ?? '/';
          const msg = child.message ?? '(no message)';
          lines.push(`    ${c.yellow('-')} ${c.cyan(at)} ${msg}`);
        }
      }
    } else if (err instanceof ContractsCodegenError) {
      lines.push(`  ${c.dim('emitter:')} ${err.emitterKind}`);
      lines.push(`  ${c.dim('schema:')}  ${err.schemaId}`);
      if (err.outputPath !== undefined) {
        lines.push(`  ${c.dim('output:')}  ${err.outputPath}`);
      }
    } else if (err instanceof ContractsSourceError) {
      lines.push(`  ${c.dim('scheme:')} ${err.scheme}`);
      lines.push(`  ${c.dim('uri:')}    ${err.uri}`);
    } else if (err instanceof ContractsPipelineError) {
      lines.push(`  ${c.dim('stage:')}  ${err.stage}`);
    } else if (err instanceof ContractsEmitterConflictError) {
      lines.push(`  ${c.dim('kind:')}    ${err.kind}`);
      lines.push(`  ${c.dim('origins:')} ${err.origins[0]}, ${err.origins[1]}`);
      lines.push('');
      lines.push(
        `  ${c.yellow('hint:')} rename one of the conflicting emitters`,
      );
    } else if (err instanceof ContractsPeerDepMissingError) {
      lines.push(`  ${c.dim('emitter:')} ${err.emitterKind}`);
      lines.push(`  ${c.dim('missing:')} ${err.packageName}`);
      lines.push('');
      lines.push(
        `  ${c.yellow('hint:')} run \`npm install ${err.packageName}\``,
      );
    }
  } else if (err instanceof Error) {
    lines.push(`${c.red(c.bold('error'))}`);
    lines.push(`  ${err.message}`);
  } else {
    lines.push(`${c.red(c.bold('error'))}`);
    lines.push(`  ${String(err)}`);
  }

  return lines.join('\n') + '\n';
}
