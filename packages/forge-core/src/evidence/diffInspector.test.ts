import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './diffInspector'

describe('parseUnifiedDiff', () => {
  it('correctly parses multi-file unified diff with additions, deletions, and modifications', () => {
    const sampleDiff = `
diff --git a/src/main/index.ts b/src/main/index.ts
index abc1234..def5678 100644
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -10,6 +10,8 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 const w = 5;
diff --git a/src/shared/newFile.ts b/src/shared/newFile.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/shared/newFile.ts
@@ -0,0 +1,3 @@
+export const a = 1;
+export const b = 2;
+export const c = 3;
diff --git a/oldDeleted.txt b/oldDeleted.txt
deleted file mode 100644
index 2222222..0000000
--- a/oldDeleted.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-first line
-second line
`.trim()

    const result = parseUnifiedDiff(sampleDiff)

    expect(result.files).toHaveLength(3)

    // File 1: modified
    expect(result.files[0]).toEqual({
      path: 'src/main/index.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      isBinary: false,
    })

    // File 2: added
    expect(result.files[1]).toEqual({
      path: 'src/shared/newFile.ts',
      status: 'added',
      additions: 3,
      deletions: 0,
      isBinary: false,
    })

    // File 3: deleted
    expect(result.files[2]).toEqual({
      path: 'oldDeleted.txt',
      status: 'deleted',
      additions: 0,
      deletions: 2,
      isBinary: false,
    })

    expect(result.totalAdditions).toBe(5)
    expect(result.totalDeletions).toBe(3)
  })

  it('handles binary file differences without errors', () => {
    const binaryDiff = `
diff --git a/assets/logo.png b/assets/logo.png
index 1234567..89abcdef 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`.trim()

    const result = parseUnifiedDiff(binaryDiff)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toEqual({
      path: 'assets/logo.png',
      status: 'modified',
      additions: 0,
      deletions: 0,
      isBinary: true,
    })
  })

  it('handles empty diff gracefully', () => {
    const result = parseUnifiedDiff('')
    expect(result.files).toHaveLength(0)
    expect(result.totalAdditions).toBe(0)
    expect(result.totalDeletions).toBe(0)
  })
})
