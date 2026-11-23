/**
 * Secret redaction by value shape.
 *
 * Lives in `shared` because two things need it and they must agree: process output on its
 * way to a log (#23) and a prompt packet on its way to an agent (#30). Two
 * implementations would drift, and the one that drifted would be the one that leaked.
 *
 * Rule R7 forbids an agent reading, echoing, logging, or transmitting a credential. Forge
 * cannot stop a child process from printing whatever it likes, so it does the two things it
 * *can* control: it declines to hand secrets over, and it scrubs anything secret-shaped out
 * of what it persists or sends.
 *
 * Stated plainly: a guardrail, not a guarantee. An agent runs with the user's own OS
 * privileges and can read `.env` itself. The point is that Forge does not help, and that a
 * captured log or a snapshotted packet is safe to keep.
 */

export const REDACTION = '[redacted]'

/**
 * Patterns for secret-shaped values.
 *
 * These match on *structure*, because the input is arbitrary text with no key names to key
 * off. Ordering matters: longer, more specific forms are replaced first, so a bearer token
 * is not partly consumed by a more general rule.
 */
const VALUE_PATTERNS: readonly RegExp[] = [
  // Authorization headers and bearer tokens.
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // `KEY=value` and `KEY: value` where the key looks secret.
  /\b[\w.-]*(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|credential)[\w.-]*\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
  // PEM blocks, which span lines.
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  // JWTs: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  // A URL carrying credentials.
  /\b([a-z][a-z0-9+.-]*):\/\/[^\s:/@]+:[^\s@]+@/gi,
]

/**
 * Scrubs secret-shaped text.
 *
 * It will over-redact sometimes; that trade is deliberate, since a redacted log is
 * recoverable by re-running and a leaked credential is not.
 */
export function redactSecrets(text: string): string {
  let result = text

  for (const pattern of VALUE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // The URL case is tested *first*. A scheme contains a colon (`https:`), so the
      // assignment branch below would otherwise claim it and produce
      // `https:[redacted]example.com` — mangling the line instead of redacting the
      // credential. Caught by a test; the ordering is the whole fix.
      const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(match)
      if (scheme !== null) return `${scheme[1] ?? ''}://${REDACTION}@`

      // Keep the assignment's key so the text still says *what* was withheld. Only a
      // separator after the first character counts, since a leading one has no key.
      const separator = /\s*[:=]\s*/.exec(match)
      if (separator?.index !== undefined && separator.index > 0) {
        return `${match.slice(0, separator.index)}${separator[0]}${REDACTION}`
      }

      return REDACTION
    })
  }

  return result
}

/**
 * Paths whose *contents* must never enter a prompt packet, whatever they contain.
 *
 * Distinct from value-shape redaction, and needed in addition to it: a `.env` file holds
 * bare `KEY=value` lines that the value patterns above would catch, but it can equally hold
 * a comment, a hostname, or a feature flag that looks harmless and is still nobody's
 * business. The file is excluded wholesale rather than scrubbed line by line.
 */
const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  // .env and every variant: .env.local, .env.production.local, env.sh
  /(^|\/)\.?env(\.[^/]*)?$/i,
  // Key material and certificates.
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  // Cloud and tool credential stores.
  /(^|\/)\.(aws|ssh|gnupg|docker|kube)\//i,
  /(^|\/)credentials(\.[^/]*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)secrets?(\.[^/]*)?$/i,
]

/**
 * Whether a file's contents are barred from a packet (axiom A7, rule R7).
 *
 * Matched against a repository-relative POSIX path. Deliberately generous: a false positive
 * costs an agent one file it could have read, and a false negative costs a credential.
 */
export function isForbiddenPath(path: string): boolean {
  const normalised = path.split('\\').join('/')
  return FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(normalised))
}
