import { defineConfig } from 'drizzle-kit'

/**
 * Migration generation only. The app never reads this config — it applies the
 * committed SQL from `src/main/db/migrations` at startup, so a user's machine
 * never needs drizzle-kit.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations',
  strict: true,
  verbose: true,
})
