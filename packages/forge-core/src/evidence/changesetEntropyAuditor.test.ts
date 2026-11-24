import { describe, expect, it } from 'vitest'
import { auditChangesetEntropy, calculateShannonEntropy } from './changesetEntropyAuditor'

describe('ChangesetEntropyAuditor', () => {
  it('calculates Shannon entropy accurately for zero-length and repetitive strings', () => {
    expect(calculateShannonEntropy('')).toBe(0)
    expect(calculateShannonEntropy('AAAAAA')).toBe(0)
    // 2 evenly distributed characters -> 1 bit per character
    expect(calculateShannonEntropy('ABABABAB')).toBe(1)
  })

  it('passes standard source code diffs with low entropy and normal line lengths', () => {
    const patch = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,5 +1,6 @@
 import { foo } from './foo'
+import { bar } from './bar'
 
 export function run() {
-  return foo()
+  return foo() + bar()
 }
`
    const report = auditChangesetEntropy(patch)
    expect(report.isSafe).toBe(true)
    expect(report.violations).toHaveLength(0)
    expect(report.hunksAudited).toBe(1)
    expect(report.overallEntropy).toBeGreaterThan(3)
    expect(report.overallEntropy).toBeLessThan(5.5)
    expect(report.summary).toContain('Entropy audit passed')
  })

  it('flags high-entropy encrypted or packed data blobs', () => {
    // Generate high-entropy pseudo-random string
    let highEntropyString = ''
    for (let i = 0; i < 256; i++) {
      highEntropyString += String.fromCharCode(32 + (i % 95))
    }

    const patch = `diff --git a/secret.bin b/secret.bin
--- a/secret.bin
+++ b/secret.bin
@@ -1,1 +1,2 @@
+${highEntropyString}
`
    const report = auditChangesetEntropy(patch, { maxHunkEntropy: 5.5 })
    expect(report.isSafe).toBe(false)
    expect(report.violations.some((v) => v.type === 'high_entropy_blob')).toBe(true)
    const violation = report.violations.find((v) => v.type === 'high_entropy_blob')
    expect(violation?.file).toBe('secret.bin')
    expect(violation?.metricValue).toBeGreaterThan(5.5)
  })

  it('flags minified lines exceeding max line length threshold', () => {
    const longLine = 'const bundle=' + 'x'.repeat(1500) + ';'
    const patch = `diff --git a/dist/bundle.js b/dist/bundle.js
--- a/dist/bundle.js
+++ b/dist/bundle.js
@@ -1,1 +1,2 @@
+${longLine}
`
    const report = auditChangesetEntropy(patch, { maxLineLength: 1000 })
    expect(report.isSafe).toBe(false)
    expect(report.violations.some((v) => v.type === 'oversized_line')).toBe(true)
    const violation = report.violations.find((v) => v.type === 'oversized_line')
    expect(violation?.metricValue).toBeGreaterThan(1000)
  })

  it('flags hunks exceeding maximum byte size threshold', () => {
    const bigHunkContent = Array.from(
      { length: 200 },
      (_, i) => `+line ${String(i)}: normal text`,
    ).join('\n')
    const patch = `diff --git a/big.txt b/big.txt
--- a/big.txt
+++ b/big.txt
@@ -1,1 +1,200 @@
${bigHunkContent}
`
    const report = auditChangesetEntropy(patch, { maxHunkBytes: 500 })
    expect(report.isSafe).toBe(false)
    expect(report.violations.some((v) => v.type === 'excessive_hunk_size')).toBe(true)
  })
})
