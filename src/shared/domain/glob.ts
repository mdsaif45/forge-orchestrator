/**
 * Glob matching for repository-relative paths.
 *
 * Written rather than taken from a dependency for two reasons. `src/shared` compiles into
 * main, preload, and the renderer and may not import anything environment-specific, and the
 * one matcher already present in the tree (`picomatch`) is a transitive dependency of a build
 * tool — relying on it would be a hidden coupling that breaks the day that tool changes its
 * own dependencies.
 *
 * The subset supported is the subset scope policies need:
 *
 * ```
 * DOUBLE-STAR    crosses separators   src/DS   matches src/a.ts AND src/deep/b.ts
 * single star    does not             src/S    matches src/a.ts, NOT src/deep/b.ts
 * ?              one character, never a separator
 * leading DS/    matches at depth zero too: DS/*.ts matches a.ts AND src/a.ts
 * dir/DS         matches the directory itself as well as its contents
 * ```
 *
 * (Written as DOUBLE-STAR and DS above because a literal star-star-slash inside a block
 * comment closes it — which broke the build the first time this was written.)
 *
 * Every one of those was measured against `picomatch` rather than recalled, because a scope
 * policy that quietly matches more than the user wrote would let an agent edit files the task
 * forbade, and one that matches less would halt legitimate work.
 */

/** Escapes the regex metacharacters a path may legitimately contain. */
function escapeLiteral(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compiles a glob to a regular expression.
 *
 * Built by scanning rather than by chained `replace` calls: a `*` inside an already-emitted
 * `[^/]*` would be rewritten by a later pass, which is the classic way these implementations
 * go subtly wrong.
 */
function compile(pattern: string): RegExp {
  let source = '^'
  let index = 0

  while (index < pattern.length) {
    const char = pattern[index]

    if (char === '*') {
      const isDoubleStar = pattern[index + 1] === '*'

      if (isDoubleStar) {
        const nextIsSlash = pattern[index + 2] === '/'

        if (nextIsSlash) {
          // A leading double-star-slash matches any number of leading segments *including
          // none*, so a pattern of double-star-slash-*.ts matches `a.ts` as well as
          // `src/a.ts`. That zero-segment case is the one a naive implementation misses.
          source += '(?:[^/]+/)*'
          index += 3
          continue
        }

        // A trailing `**` matches the rest of the path, and also nothing — so `src/**`
        // matches the directory `src` itself, matching picomatch.
        source += '.*'
        index += 2
        continue
      }

      // A single star stops at a separator.
      source += '[^/]*'
      index += 1
      continue
    }

    if (char === '?') {
      source += '[^/]'
      index += 1
      continue
    }

    if (char === '/') {
      // `dir/**` already consumed its slash above. A `/` immediately before a trailing `**`
      // is made optional so `src/**` matches `src`.
      if (pattern.slice(index) === '/**') {
        source += '(?:/.*)?'
        index += 3
        continue
      }

      source += '/'
      index += 1
      continue
    }

    source += escapeLiteral(char ?? '')
    index += 1
  }

  return new RegExp(`${source}$`)
}

const cache = new Map<string, RegExp>()

/**
 * Whether a path matches a glob.
 *
 * Compiled patterns are cached: scope checks run once per changed file per step, and a
 * workflow touching fifty files would otherwise recompile the same handful of patterns fifty
 * times.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let expression = cache.get(pattern)

  if (expression === undefined) {
    expression = compile(pattern)
    cache.set(pattern, expression)
  }

  // Normalised so a caller that forgot is not silently wrong: git reports POSIX paths, but a
  // path arriving from elsewhere on Windows may not.
  return expression.test(path.split('\\').join('/'))
}

/** Whether a path matches any of the patterns. An empty list matches nothing. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern))
}

/** The first pattern a path matches, for an error message that names the rule. */
export function firstMatching(path: string, patterns: readonly string[]): string | null {
  return patterns.find((pattern) => matchesGlob(path, pattern)) ?? null
}
