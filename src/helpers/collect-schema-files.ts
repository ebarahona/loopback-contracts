import {readdir} from 'node:fs/promises';
import {join} from 'node:path';

/**
 * Recursively walks `rootDir` and returns absolute paths of every
 * `*.schema.json` file. Output is deterministically sorted (lexicographic on
 * the absolute path) so downstream `$id`-collision messages are stable across
 * platforms — `readdir` order is filesystem-dependent and varies between
 * Linux, macOS, and Windows.
 *
 * Skips `node_modules`, `dist`, and any dot-directory (e.g. `.git`, `.cache`)
 * — these are never legitimate authored-schema locations, and excluding them
 * keeps the walker bounded on large project trees.
 *
 * Implementation is a hand-rolled BFS using `fs.readdir(withFileTypes: true)`
 * so we avoid a glob dependency and stay fast on deep trees.
 *
 * @internal
 */
export async function collectSchemaFiles(rootDir: string): Promise<string[]> {
  const out: string[] = [];
  // BFS via `queue.shift()`. Traversal order is irrelevant because the
  // result is lexicographically sorted before return — matches the DFS
  // walker in `local-source.ts` bit-for-bit. Pick whichever read more
  // cleanly here without worrying about output divergence.
  const queue: string[] = [rootDir];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;
    const entries = await readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name.startsWith('.')
        ) {
          continue;
        }
        queue.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.schema.json')) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
