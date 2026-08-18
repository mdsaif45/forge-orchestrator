/**
 * Writes the workflow state diagram into `docs/DOMAIN.md` from the transition table.
 *
 * The diagram is generated rather than maintained by hand because a diagram kept beside a
 * table is a diagram that eventually lies — and this one describes the heart of Forge, so a
 * stale version would mislead precisely where it matters most.
 *
 * ```
 * npm run docs:diagram          rewrite the block
 * npm run docs:diagram -- --check   fail if it is out of date   (used by npm run check)
 * ```
 *
 * The block is delimited by HTML comments so the surrounding prose is untouched.
 */
import { readFileSync, writeFileSync } from 'node:fs'
// Bundled by the npm script before this runs, rather than added as a build entry: the
// transition table is pure data with no Electron or Node dependency, so esbuild alone is
// enough — the same approach `check:router` already takes.
import { renderStateDiagram } from './build/transitions.js'

const DOC = 'docs/DOMAIN.md'
const BEGIN = '<!-- BEGIN GENERATED STATE DIAGRAM -->'
const END = '<!-- END GENERATED STATE DIAGRAM -->'

const checkOnly = process.argv.includes('--check')

const source = readFileSync(DOC, 'utf8')
const begin = source.indexOf(BEGIN)
const end = source.indexOf(END)

if (begin === -1 || end === -1) {
  console.error(`${DOC} is missing the generated-diagram markers (${BEGIN} … ${END})`)
  process.exit(1)
}

const block = [
  BEGIN,
  '',
  '<!-- Generated from src/shared/domain/transitions.ts by npm run docs:diagram. Do not edit. -->',
  '',
  '```mermaid',
  renderStateDiagram(),
  '```',
  '',
].join('\n')

const updated = source.slice(0, begin) + block + source.slice(end)

if (updated === source) {
  console.log(`${DOC}: state diagram is up to date`)
  process.exit(0)
}

if (checkOnly) {
  console.error(
    `${DOC}: the state diagram is out of date. Run \`npm run docs:diagram\` and commit the result.`,
  )
  process.exit(1)
}

writeFileSync(DOC, updated)
console.log(`${DOC}: state diagram rewritten`)
