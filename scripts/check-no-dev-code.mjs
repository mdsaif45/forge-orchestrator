/**
 * Asserts the release renderer bundle contains no development-only code.
 *
 * The kitchen sink is a component gallery for verifying primitives, and it shipped
 * to end users in v0.1.0-alpha.1 (#103). Gating it on `import.meta.env.DEV` fixes
 * that once; this check is what stops it coming back, because the failure is silent
 * — a static import quietly pulls the chunk back into the graph and nothing else
 * would notice.
 *
 * Asserts against the built artifact rather than the source: the question is what
 * the bundler actually emitted, not what the source appears to say. Grepping source
 * would pass while the bundle still carried the code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER_OUT = 'out/renderer'

/** Strings that must never appear in a release renderer bundle. */
const FORBIDDEN = [
  { needle: 'Kitchen sink', why: 'kitchen sink heading' },
  { needle: 'kitchen-sink', why: 'kitchen sink markup' },
  { needle: 'Every primitive, every variant', why: 'kitchen sink subtitle' },
]

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

let checked = 0
const violations = []

for (const file of filesUnder(RENDERER_OUT)) {
  if (!/\.(js|html|css)$/.test(file)) continue
  if (statSync(file).size === 0) continue

  const contents = readFileSync(file, 'utf8')
  checked += 1

  for (const { needle, why } of FORBIDDEN) {
    if (contents.includes(needle)) {
      violations.push(`${file}: contains ${why} ("${needle}")`)
    }
  }
}

if (checked === 0) {
  console.error(`No renderer assets found under ${RENDERER_OUT}. Run "npm run build" first.`)
  process.exit(1)
}

if (violations.length > 0) {
  console.error('Development-only code reached the release bundle:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    '\nThe kitchen sink must be behind `import.meta.env.DEV` and imported dynamically,' +
      '\nso the bundler can drop the chunk. A static import keeps it in the graph.',
  )
  process.exit(1)
}

console.log(`No dev-only code in the release bundle (${String(checked)} assets checked)`)
