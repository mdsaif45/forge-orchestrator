import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Record of a successful agent session turn that can be warm-resumed (#157).
 */
export const warmSessionRecordSchema = z.strictObject({
  workflowId: z.string().min(1),
  role: z.string().min(1),
  runtimeId: z.string().min(1),
  providerSessionId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
})

export type WarmSessionRecord = z.infer<typeof warmSessionRecordSchema>

/**
 * Manages persisted warm session IDs across workflow steps.
 *
 * Axiom A6 (No Provider in Core):
 * Core knows only that a session ID exists and belongs to a (workflowId, role, runtimeId) tuple;
 * it never interprets or parses provider-specific token formats.
 */
export class WarmSessionStore {
  private readonly storePath: string
  private readonly sessions = new Map<string, WarmSessionRecord>()

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true })
    this.storePath = join(directory, 'warm-sessions.json')
    this.load()
  }

  private key(workflowId: string, role: string, runtimeId: string): string {
    return `${workflowId}::${role}::${runtimeId}`
  }

  private load(): void {
    if (!existsSync(this.storePath)) return
    try {
      const raw = readFileSync(this.storePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const res = warmSessionRecordSchema.safeParse(item)
          if (res.success) {
            this.sessions.set(
              this.key(res.data.workflowId, res.data.role, res.data.runtimeId),
              res.data,
            )
          }
        }
      }
    } catch {
      // Corrupt or unparseable store falls back to an empty cache
      this.sessions.clear()
    }
  }

  private persist(): void {
    try {
      const list = Array.from(this.sessions.values())
      writeFileSync(this.storePath, JSON.stringify(list, null, 2), 'utf8')
    } catch {
      // Disk write failure is non-fatal: in-memory cache continues to serve turns
    }
  }

  save(record: WarmSessionRecord): void {
    this.sessions.set(this.key(record.workflowId, record.role, record.runtimeId), record)
    this.persist()
  }

  find(workflowId: string, role: string, runtimeId: string): string | null {
    const rec = this.sessions.get(this.key(workflowId, role, runtimeId))
    return rec ? rec.providerSessionId : null
  }

  invalidate(workflowId: string, role: string, runtimeId: string): void {
    this.sessions.delete(this.key(workflowId, role, runtimeId))
    this.persist()
  }

  clearForWorkflow(workflowId: string): void {
    for (const [k, v] of this.sessions.entries()) {
      if (v.workflowId === workflowId) {
        this.sessions.delete(k)
      }
    }
    this.persist()
  }
}
