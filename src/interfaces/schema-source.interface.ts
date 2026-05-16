/**
 * Plugin-contributed loader for a schema-source URI scheme.
 *
 * The engine ships built-in sources for `local`, `npm:`, `git+`, and
 * `https://` URIs. Third parties can register additional schemes (e.g.,
 * `s3://`, `gh://`, `gcs://`) by binding a `SchemaSource` under
 * {@link ContractsBindings.SOURCE_TAG | SOURCE_TAG}. The engine selects the
 * source by matching {@link SchemaSource.scheme}.
 *
 * @public
 */
export interface SchemaSource {
  /**
   * URI scheme this source handles, with no trailing colon. Matched
   * case-insensitively against the prefix of the user-supplied URI in
   * `loopback.config.json`'s `schemas[]` array.
   *
   * @example `'s3'`, `'gh'`, `'gcs'`
   */
  readonly scheme: string;

  /**
   * Fetch every schema file the URI resolves to. Implementations return the
   * raw file contents; the engine handles parsing, caching, and registration
   * into the {@link SchemaRegistry}.
   */
  fetch(uri: string): Promise<SchemaSourceResult>;
}

/**
 * Result of a {@link SchemaSource.fetch} call — one entry per discovered file.
 *
 * @public
 */
export type SchemaSourceResult = ReadonlyArray<{
  /** The original URI the source was asked to fetch. */
  readonly source: string;
  /** Logical path of the file inside the source (forward-slash separated). */
  readonly path: string;
  /** Raw file contents (UTF-8). */
  readonly content: string;
}>;
