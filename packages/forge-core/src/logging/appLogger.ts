import { appendFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '@shared/domain'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface AppLoggerOptions {
  readonly logDir: string
  readonly maxFileSizeMb?: number
}

export class AppLogger {
  private readonly logPath: string
  private readonly maxBytes: number

  constructor(options: AppLoggerOptions) {
    if (!existsSync(options.logDir)) {
      mkdirSync(options.logDir, { recursive: true })
    }
    this.logPath = join(options.logDir, 'forge-app.log')
    this.maxBytes = (options.maxFileSizeMb ?? 10) * 1024 * 1024
  }

  log(level: LogLevel, tag: string, message: string, data?: unknown): void {
    try {
      this.rotateIfNeeded()

      const timestamp = new Date().toISOString()
      const safeTag = redactSecrets(tag)
      const safeMessage = redactSecrets(message)
      const extra = data !== undefined ? ` | ${redactSecrets(JSON.stringify(data))}` : ''
      const entry = `[${timestamp}] [${level}] [${safeTag}] ${safeMessage}${extra}\n`

      appendFileSync(this.logPath, entry, 'utf8')
    } catch {
      // Disk logging should never crash the caller
    }
  }

  info(tag: string, message: string, data?: unknown): void {
    this.log('INFO', tag, message, data)
  }

  warn(tag: string, message: string, data?: unknown): void {
    this.log('WARN', tag, message, data)
  }

  error(tag: string, message: string, data?: unknown): void {
    this.log('ERROR', tag, message, data)
  }

  private rotateIfNeeded(): void {
    try {
      if (existsSync(this.logPath)) {
        const stats = statSync(this.logPath)
        if (stats.size > this.maxBytes) {
          unlinkSync(this.logPath)
        }
      }
    } catch {
      // Rotation failures are non-fatal
    }
  }
}
