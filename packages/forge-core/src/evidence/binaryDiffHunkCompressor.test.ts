import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  BinaryDiffHunkCompressor,
  BinaryPatchBaseMismatchError,
  BinaryPatchCorruptionError,
  BinaryPatchSignatureError,
  type CompressionAlgorithm,
} from './binaryDiffHunkCompressor'

describe('BinaryDiffHunkCompressor (EVIDENCE-028)', () => {
  it('compresses identical, mutated, and appended chunks using COPY, XOR_DELTA, and REPLACE hunks', async () => {
    const compressor = new BinaryDiffHunkCompressor({ chunkSize: 1024, algorithm: 'gzip' })

    // 3KB base: chunk 0 = A*1024, chunk 1 = B*1024, chunk 2 = C*1024
    const base = Buffer.concat([
      Buffer.alloc(1024, 0x41),
      Buffer.alloc(1024, 0x42),
      Buffer.alloc(1024, 0x43),
    ])

    // Target:
    // chunk 0: identical (COPY)
    // chunk 1: mostly B*1024 with 4 mutated bytes (XOR_DELTA -> compresses tiny!)
    // chunk 2: identical (COPY)
    // chunk 3: appended 512 bytes of D (REPLACE)
    const mutatedChunk1 = Buffer.alloc(1024, 0x42)
    mutatedChunk1[10] = 0x7a
    mutatedChunk1[11] = 0x7b
    mutatedChunk1[500] = 0x7c
    mutatedChunk1[1000] = 0x7d

    const appendedChunk3 = Buffer.alloc(512, 0x44)
    const target = Buffer.concat([
      Buffer.alloc(1024, 0x41),
      mutatedChunk1,
      Buffer.alloc(1024, 0x43),
      appendedChunk3,
    ])

    const patch = await compressor.compressDiff(base, target, {
      filePath: 'assets/firmware.bin',
    })

    expect(patch.filePath).toBe('assets/firmware.bin')
    expect(patch.hunkCount).toBe(4)
    expect(patch.copiedChunksCount).toBe(2)
    expect(patch.deltaChunksCount).toBe(1)
    expect(patch.replacedChunksCount).toBe(1)
    expect(patch.hunks[0]?.operation).toBe('COPY')
    expect(patch.hunks[0]?.compressedLength).toBe(0)
    expect(patch.hunks[1]?.operation).toBe('XOR_DELTA')
    expect(patch.hunks[2]?.operation).toBe('COPY')
    expect(patch.hunks[3]?.operation).toBe('REPLACE')
    expect(patch.spaceSavingsPercent).toBeGreaterThan(90)
    expect(patch.signatureEnvelope.signatureAlgorithm).toBe('sha256-digest')

    const verification = compressor.verifyPatchSignature(patch)
    expect(verification.valid).toBe(true)
    expect(verification.signatureValid).toBe(true)
    expect(verification.manifestDigestMatch).toBe(true)
    expect(verification.chunkDigestsValid).toBe(true)

    const restored = await compressor.decompressPatchStrict(patch, base)
    expect(restored.success).toBe(true)
    expect(restored.fidelityVerified).toBe(true)
    expect(restored.reconstructedBytes).toBe(target.length)
    expect(Buffer.compare(restored.outputBuffer, target)).toBe(0)
  })

  it.each<CompressionAlgorithm>(['gzip', 'deflate', 'brotli'])(
    'supports lossless round-trip compression and verification with %s algorithm',
    async (algorithm) => {
      const compressor = new BinaryDiffHunkCompressor({ algorithm, chunkSize: 512 })
      const base = Buffer.from('forge-binary-header-v1-'.repeat(40), 'utf8')
      const target = Buffer.from(
        'forge-binary-header-v2-'.repeat(45) + 'tail-payload-12345',
        'utf8',
      )

      const patch = await compressor.compressDiff(base, target, { filePath: `bundle.${algorithm}` })
      expect(patch.algorithm).toBe(algorithm)

      const decompressed = await compressor.decompressPatch(patch, base)
      expect(decompressed.success).toBe(true)
      expect(decompressed.fidelityVerified).toBe(true)
      expect(Buffer.compare(decompressed.outputBuffer, target)).toBe(0)
    },
  )

  it('compresses and reconstructs binary streams across irregular stream chunk boundaries', async () => {
    const compressor = new BinaryDiffHunkCompressor({ chunkSize: 256, algorithm: 'brotli' })
    const base = Buffer.alloc(600, 0x11)
    const target = Buffer.concat([
      Buffer.alloc(256, 0x11), // chunk 0 identical (COPY)
      Buffer.alloc(256, 0x22), // chunk 1 different same size (XOR_DELTA)
      Buffer.alloc(200, 0x33), // chunk 2 longer than remaining 88 bytes in base (REPLACE)
    ])

    // Emit irregular small chunks (70 bytes at a time)
    function* fragmentedChunks(): Generator<Buffer> {
      for (let i = 0; i < target.length; i += 70) {
        yield target.subarray(i, Math.min(i + 70, target.length))
      }
    }

    const stream = Readable.from(fragmentedChunks())
    const patch = await compressor.compressStream(stream, base, { filePath: 'stream.wasm' })

    expect(patch.hunkCount).toBe(3)
    expect(patch.copiedChunksCount).toBe(1)
    expect(patch.deltaChunksCount).toBe(1)
    expect(patch.replacedChunksCount).toBe(1)
    expect(patch.targetTotalBytes).toBe(target.length)

    const result = await compressor.decompressPatchStrict(patch, base)
    expect(result.fidelityVerified).toBe(true)
    expect(Buffer.compare(result.outputBuffer, target)).toBe(0)
  })

  it('handles empty buffers and empty streams deterministically', async () => {
    const compressor = new BinaryDiffHunkCompressor()
    const emptyPatch = await compressor.compressStream(Readable.from([]))
    expect(emptyPatch.hunkCount).toBe(0)
    expect(emptyPatch.totalOriginalBytes).toBe(0)
    expect(emptyPatch.compressionRatio).toBe(1)
    expect(emptyPatch.spaceSavingsPercent).toBe(0)

    const restored = await compressor.decompressPatchStrict(emptyPatch, Buffer.alloc(0))
    expect(restored.success).toBe(true)
    expect(restored.reconstructedBytes).toBe(0)
  })

  it('supports HMAC-SHA256 signing and enforces secret verification (fail-closed A2)', async () => {
    const compressor = new BinaryDiffHunkCompressor({
      signingSecret: 'super-secret-signing-key-028',
      keyId: 'key-prod-1',
    })

    const base = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
    const target = Buffer.from([1, 2, 99, 4, 5, 6, 7, 100])

    const patch = await compressor.compressDiff(base, target)
    expect(patch.signatureEnvelope.signatureAlgorithm).toBe('hmac-sha256')
    expect(patch.signatureEnvelope.keyId).toBe('key-prod-1')

    expect(compressor.verifyPatchSignature(patch).valid).toBe(true)

    // Wrong secret must fail verification
    const wrongVerifier = new BinaryDiffHunkCompressor({ signingSecret: 'wrong-key' })
    const badCheck = wrongVerifier.verifyPatchSignature(patch)
    expect(badCheck.valid).toBe(false)
    expect(badCheck.signatureValid).toBe(false)
    expect(badCheck.errors).toContain('HMAC-SHA256 signature verification failed')

    // Missing secret must fail verification
    const keylessVerifier = new BinaryDiffHunkCompressor()
    const keylessCheck = keylessVerifier.verifyPatchSignature(patch)
    expect(keylessCheck.valid).toBe(false)
    expect(keylessCheck.errors).toContain(
      'HMAC-SHA256 patch requires a signingSecret for verification',
    )

    await expect(wrongVerifier.decompressPatchStrict(patch, base)).rejects.toThrow(
      BinaryPatchSignatureError,
    )
  })

  it('detects hunk payload tampering, manifest forgery, and base buffer mismatches', async () => {
    const compressor = new BinaryDiffHunkCompressor({ chunkSize: 64 })
    const base = Buffer.alloc(128, 0xaa)
    const target = Buffer.alloc(128, 0xbb)

    const patch = await compressor.compressDiff(base, target)

    // 1. Tamper with chunk payload without updating digest
    const tamperedHunkPayload = Buffer.from('corrupted-data').toString('base64')
    const tamperedPatch = {
      ...patch,
      hunks: patch.hunks.map((h, idx) =>
        idx === 0 ? { ...h, payloadBase64: tamperedHunkPayload } : h,
      ),
    }

    const tamperedVerify = compressor.verifyPatchSignature(tamperedPatch)
    expect(tamperedVerify.valid).toBe(false)
    expect(tamperedVerify.chunkDigestsValid).toBe(false)
    expect(tamperedVerify.invalidChunkIndices).toContain(0)

    // 2. Tamper with metadata header (e.g. filePath)
    const forgedMetadataPatch = {
      ...patch,
      filePath: '../../etc/passwd',
    }
    const forgedVerify = compressor.verifyPatchSignature(forgedMetadataPatch)
    expect(forgedVerify.valid).toBe(false)
    expect(forgedVerify.manifestDigestMatch).toBe(false)

    // 3. Supply wrong base buffer during decompression
    const wrongBase = Buffer.alloc(128, 0xcc)
    const baseFailResult = await compressor.decompressPatch(patch, wrongBase)
    expect(baseFailResult.success).toBe(false)
    expect(baseFailResult.error).toContain('Base buffer SHA-256 mismatch')

    await expect(compressor.decompressPatchStrict(patch, wrongBase)).rejects.toThrow(
      BinaryPatchBaseMismatchError,
    )

    // 4. Bypass signature verification to trigger BinaryPatchCorruptionError on invalid compressed bytes
    await expect(
      compressor.decompressPatchStrict(tamperedPatch, base, { verifySignature: false }),
    ).rejects.toThrow(BinaryPatchCorruptionError)
  })

  it('rejects non-positive chunkSize parameters', async () => {
    expect(() => new BinaryDiffHunkCompressor({ chunkSize: 0 })).toThrow(RangeError)
    const compressor = new BinaryDiffHunkCompressor()
    await expect(
      compressor.compressDiff(Buffer.alloc(10), Buffer.alloc(10), { chunkSize: -5 }),
    ).rejects.toThrow(RangeError)
  })
})
