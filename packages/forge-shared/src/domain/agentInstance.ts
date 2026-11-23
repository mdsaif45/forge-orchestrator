import { z } from 'zod'
import { roleSchema } from './enums'
import { accountIdSchema, agentInstanceIdSchema, projectIdSchema, timestampSchema } from './ids'

/**
 * An agent instance entity managed by Forge (#138).
 *
 * Identity belongs to the agent instance, not to the provider or role.
 * A generated name is for humans reading a log or picking from a dropdown;
 * a UUID is for correctness. Renaming an agent never changes its identity or bindings.
 */
export const agentInstanceSchema = z.strictObject({
  id: agentInstanceIdSchema,
  projectId: projectIdSchema,
  name: z.string().min(1),
  label: z.string().min(1),
  provider: z.string().min(1),
  accountId: accountIdSchema.nullable(),
  role: roleSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
})

export type AgentInstance = z.infer<typeof agentInstanceSchema>

const ADJECTIVES: readonly string[] = [
  'Noble',
  'Swift',
  'Bold',
  'Keen',
  'Calm',
  'Vivid',
  'Grand',
  'Wise',
  'Bright',
  'Brave',
  'Silent',
  'Loyal',
  'Crisp',
  'Lucid',
  'Agile',
  'Hardy',
  'Quick',
  'Solar',
  'Stellar',
  'Lunar',
  'Mystic',
  'Frost',
  'Storm',
  'Ember',
  'Iron',
  'Amber',
  'Cedar',
  'Atlas',
  'Nova',
  'Zenith',
]

const NOUNS: readonly string[] = [
  'Falcon',
  'Otter',
  'Lynx',
  'Badger',
  'Raven',
  'Hawk',
  'Beaver',
  'Fox',
  'Panther',
  'Osprey',
  'Wolf',
  'Crane',
  'Heron',
  'Jaguar',
  'Eagle',
  'Cobra',
  'Phoenix',
  'Griffin',
  'Seal',
  'Finch',
  'Robin',
  'Bison',
  'Tiger',
  'Panda',
  'Sable',
]

/**
 * Generates a stable, human-readable name in PascalCase (e.g. "NobleFalcon").
 * Guarantees uniqueness against `existingNames` within a project.
 */
export function generateAgentName(existingNames: Iterable<string> = []): string {
  const existingSet = new Set(existingNames)

  // Try random combinations first
  for (let attempt = 0; attempt < 100; attempt++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] ?? 'Noble'
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)] ?? 'Falcon'
    const candidate = `${adj}${noun}`
    if (!existingSet.has(candidate)) {
      return candidate
    }
  }

  // Deterministic fallback with numeric suffix if all random attempts collide
  const baseAdj = ADJECTIVES[0] ?? 'Noble'
  const baseNoun = NOUNS[0] ?? 'Falcon'
  let counter = 2
  while (counter < 100_000) {
    const candidate = `${baseAdj}${baseNoun}${String(counter)}`
    if (!existingSet.has(candidate)) {
      return candidate
    }
    counter++
  }
  return `${baseAdj}${baseNoun}${String(Date.now())}`
}
