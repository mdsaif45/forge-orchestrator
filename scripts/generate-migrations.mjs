/**
 * Inlines the committed migration SQL into a TypeScript module.
 *
 * The app must not read migration files at runtime: in a packaged build the
 * directory would have to be shipped as an unpacked resource with a path that
 * stays correct in dev, in the bundle, and inside an installer. A missing folder
 * would surface as "no such table" at first use, which points nowhere near the
 * cause.
 *
 * Inlining makes the SQL part of the bundle, so it cannot be absent.
 * Regenerate after every `drizzle-kit generate`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join('src', 'main', 'db', 'migrations')
const OUTPUT = join('src', 'main', 'db', 'migrations.generated.ts')

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()

if (files.length === 0) {
  console.error(`No .sql files found in ${MIGRATIONS_DIR}`)
  process.exit(1)
}

const entries = files.map((name) => {
  const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
  const tag = name.replace(/\.sql$/, '')

  // A template literal keeps the SQL readable in the generated file; backticks and
  // ${ must be escaped so the content cannot terminate or interpolate.
  const escaped = sql.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

  return `  {\n    tag: '${tag}',\n    sql: \`${escaped}\`,\n  },`
})

const output = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by \`npm run db:generate\` from src/main/db/migrations/*.sql.
 * Inlined so a packaged app never reads migration files from disk.
 */
import type { Migration } from './migrate'

export const MIGRATIONS: readonly Migration[] = [
${entries.join('\n')}
]
`

writeFileSync(OUTPUT, output, 'utf8')
console.log(`Inlined ${String(files.length)} migration(s) into ${OUTPUT}`)
