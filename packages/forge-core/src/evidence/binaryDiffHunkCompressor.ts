/**
 * EVIDENCE-028: Binary Diff Hunk Compressor and Content-Digest Signer.
 *
 * Provides chunked binary delta representation (COPY / XOR_DELTA / REPLACE)
 * with zlib stream compression (gzip, deflate, brotli), SHA-256 / HMAC-SHA256
 * content-digest signing, tamper detection, and verified lossless
 * decompression for large artifacts and binary changesets (Axioms A1, A2, A3, A6).
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { PassThrough, Readable, type Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createGunzip,
  createGzip,
  createInflate,
} from 'node:zlib'

export type CompressionAlgorithm = 'gzip' | 'deflate' | 'brotli'

export type BinaryHunkOperation = 'COPY' | 'XOR_DELTA' | 'REPLACE'

export interface BinaryChunkDigest {
  readonly chunkIndex: number
  readonly offset: number
  readonly originalLength: number
  readonly compressedLength: number
  readonly operation: BinaryHunkOperation
  readonly baseChunkSha256: string | null
  readonly targetChunkSha256: string
  readonly compressedPayloadSha256: string
  readonly payloadBase64: string
}

export interface PatchSignatureEnvelope {
  readonly signatureVersion: '1.0'
  readonly digestAlgorithm: 'sha256'
  readonly signatureAlgorithm: 'sha256-digest' | 'hmac-sha256'
  readonly manifestContentDigest: string
  readonly signature: string
  readonly keyId?: string | undefined
  readonly signedAt: number
}

export interface CompressedPatch {
  readonly patchId: string
  readonly filePath: string
  readonly algorithm: CompressionAlgorithm
  readonly chunkSize: number
  readonly baseTotalBytes: number
  readonly targetTotalBytes: number
  readonly baseSha256: string
  readonly targetSha256: string
  readonly totalOriginalBytes: number
  readonly totalCompressedBytes: number
  readonly compressionRatio: number
  readonly spaceSavingsPercent: number
  readonly hunkCount: number
  readonly copiedChunksCount: number
  readonly deltaChunksCount: number
  readonly replacedChunksCount: number
  readonly hunks: readonly BinaryChunkDigest[]
  readonly signatureEnvelope: PatchSignatureEnvelope
}

export interface CompressDiffOptions {
  readonly filePath?: string | undefined
  readonly algorithm?: CompressionAlgorithm | undefined
  readonly chunkSize?: number | undefined
  readonly signingSecret?: string | undefined
  readonly keyId?: string | undefined
}

export interface VerifyPatchOptions {
  readonly signingSecret?: string | undefined
}

export interface PatchVerificationResult {
  readonly valid: boolean
  readonly patchId: string
  readonly signatureValid: boolean
  readonly manifestDigestMatch: boolean
  readonly chunkDigestsValid: boolean
  readonly invalidChunkIndices: readonly number[]
  readonly errors: readonly string[]
}

export interface DecompressPatchOptions {
  readonly signingSecret?: string | undefined
  readonly verifySignature?: boolean | undefined
}

export interface DecompressionResult {
  readonly success: boolean
  readonly patchId: string
  readonly filePath: string
  readonly outputBuffer: Buffer
  readonly reconstructedBytes: number
  readonly reconstructedSha256: string
  readonly expectedTargetSha256: string
  readonly fidelityVerified: boolean
  readonly verification: PatchVerificationResult
  readonly error?: string | undefined
}

export class BinaryPatchSignatureError extends Error {
  constructor(patchId: string, details: string) {
    super(`Binary patch signature verification failed for "${patchId}": ${details}`)
    this.name = 'BinaryPatchSignatureError'
  }
}

export class BinaryPatchCorruptionError extends Error {
  constructor(patchId: string, details: string) {
    super(`Binary patch payload corruption detected for "${patchId}": ${details}`)
    this.name = 'BinaryPatchCorruptionError'
  }
}

export class BinaryPatchBaseMismatchError extends Error {
  constructor(patchId: string, expectedSha256: string, actualSha256: string) {
    super(
      `Binary patch "${patchId}" base buffer mismatch: expected ${expectedSha256}, got ${actualSha256}`,
    )
    this.name = 'BinaryPatchBaseMismatchError'
  }
}

const DEFAULT_CHUNK_SIZE = 4096
const DEFAULT_ALGORITHM: CompressionAlgorithm = 'gzip'

function sha256Buffer(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function sha256String(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function createCompressStream(algorithm: CompressionAlgorithm): Transform {
  switch (algorithm) {
    case 'gzip':
      return createGzip()
    case 'deflate':
      return createDeflate()
    case 'brotli':
      return createBrotliCompress()
  }
}

function createDecompressStream(algorithm: CompressionAlgorithm): Transform {
  switch (algorithm) {
    case 'gzip':
      return createGunzip()
    case 'deflate':
      return createInflate()
    case 'brotli':
      return createBrotliDecompress()
  }
}

async function compressBufferViaStream(
  input: Buffer,
  algorithm: CompressionAlgorithm,
): Promise<Buffer> {
  const source = Readable.from([input])
  const compressor = createCompressStream(algorithm)
  const sink = new PassThrough()
  const chunks: Buffer[] = []
  sink.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  await pipeline(source, compressor, sink)
  return Buffer.concat(chunks)
}

async function decompressBufferViaStream(
  compressed: Buffer,
  algorithm: CompressionAlgorithm,
): Promise<Buffer> {
  const source = Readable.from([compressed])
  const decompressor = createDecompressStream(algorithm)
  const sink = new PassThrough()
  const chunks: Buffer[] = []
  sink.on('data', (chunk: Buffer) => {
    chunks.push(chunk)
  })
  await pipeline(source, decompressor, sink)
  return Buffer.concat(chunks)
}

function xorBuffers(left: Buffer, right: Buffer): Buffer {
  const out = Buffer.allocUnsafe(left.length)
  for (let i = 0; i < left.length; i += 1) {
    out[i] = (left[i] ?? 0) ^ (right[i] ?? 0)
  }
  return out
}

function timingSafeHexEqual(expectedHex: string, actualHex: string): boolean {
  if (expectedHex.length !== actualHex.length || expectedHex.length === 0) {
    return false
  }
  const expectedBuf = Buffer.from(expectedHex, 'hex')
  const actualBuf = Buffer.from(actualHex, 'hex')
  if (expectedBuf.length !== actualBuf.length || expectedBuf.length === 0) {
    return false
  }
  return timingSafeEqual(expectedBuf, actualBuf)
}

function computeCanonicalManifestDigest(params: {
  readonly patchId: string
  readonly filePath: string
  readonly algorithm: CompressionAlgorithm
  readonly chunkSize: number
  readonly baseTotalBytes: number
  readonly targetTotalBytes: number
  readonly baseSha256: string
  readonly targetSha256: string
  readonly hunks: readonly BinaryChunkDigest[]
}): string {
  const hunkDescriptors = params.hunks
    .map(
      (h) =>
        `${String(h.chunkIndex)}:${String(h.offset)}:${String(h.originalLength)}:${String(h.compressedLength)}:${h.operation}:${h.baseChunkSha256 ?? 'null'}:${h.targetChunkSha256}:${h.compressedPayloadSha256}`,
    )
    .join('|')

  const canonical = [
    params.patchId,
    params.filePath,
    params.algorithm,
    String(params.chunkSize),
    String(params.baseTotalBytes),
    String(params.targetTotalBytes),
    params.baseSha256,
    params.targetSha256,
    hunkDescriptors,
  ].join('\n')

  return sha256String(canonical)
}

function computeEnvelopeSignature(
  manifestContentDigest: string,
  signingSecret?: string,
): {
  readonly signatureAlgorithm: 'sha256-digest' | 'hmac-sha256'
  readonly signature: string
} {
  if (signingSecret !== undefined) {
    const signature = createHmac('sha256', signingSecret)
      .update(manifestContentDigest, 'utf8')
      .digest('hex')
    return { signatureAlgorithm: 'hmac-sha256', signature }
  }
  const signature = sha256String(`forge-evidence-028:${manifestContentDigest}`)
  return { signatureAlgorithm: 'sha256-digest', signature }
}

async function encodeSingleHunk(params: {
  readonly chunkIndex: number
  readonly offset: number
  readonly baseSlice: Buffer
  readonly targetSlice: Buffer
  readonly algorithm: CompressionAlgorithm
}): Promise<BinaryChunkDigest> {
  const { chunkIndex, offset, baseSlice, targetSlice, algorithm } = params
  const baseChunkSha256 = baseSlice.length > 0 ? sha256Buffer(baseSlice) : null
  const targetChunkSha256 = sha256Buffer(targetSlice)

  let operation: BinaryHunkOperation
  let compressedBuffer: Buffer

  if (baseSlice.length > 0 && baseSlice.equals(targetSlice)) {
    operation = 'COPY'
    compressedBuffer = Buffer.alloc(0)
  } else if (baseSlice.length === targetSlice.length && baseSlice.length > 0) {
    operation = 'XOR_DELTA'
    const delta = xorBuffers(baseSlice, targetSlice)
    compressedBuffer = await compressBufferViaStream(delta, algorithm)
  } else {
    operation = 'REPLACE'
    compressedBuffer = await compressBufferViaStream(targetSlice, algorithm)
  }

  return {
    chunkIndex,
    offset,
    originalLength: targetSlice.length,
    compressedLength: compressedBuffer.length,
    operation,
    baseChunkSha256,
    targetChunkSha256,
    compressedPayloadSha256: sha256Buffer(compressedBuffer),
    payloadBase64: compressedBuffer.toString('base64'),
  }
}

export class BinaryDiffHunkCompressor {
  private readonly defaultAlgorithm: CompressionAlgorithm
  private readonly defaultChunkSize: number
  private readonly defaultSigningSecret?: string | undefined
  private readonly defaultKeyId?: string | undefined

  constructor(config?: {
    readonly algorithm?: CompressionAlgorithm | undefined
    readonly chunkSize?: number | undefined
    readonly signingSecret?: string | undefined
    readonly keyId?: string | undefined
  }) {
    const chunkSize = config?.chunkSize ?? DEFAULT_CHUNK_SIZE
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError(`Invalid chunkSize: ${String(chunkSize)}. Must be a positive integer.`)
    }
    this.defaultAlgorithm = config?.algorithm ?? DEFAULT_ALGORITHM
    this.defaultChunkSize = chunkSize
    this.defaultSigningSecret = config?.signingSecret
    this.defaultKeyId = config?.keyId
  }

  /**
   * Computes a chunked, stream-compressed binary delta between `baseBuffer` and `targetBuffer`
   * and signs the resulting manifest with a SHA-256 or HMAC-SHA256 content-digest envelope.
   */
  async compressDiff(
    baseBuffer: Buffer,
    targetBuffer: Buffer,
    options: CompressDiffOptions = {},
  ): Promise<CompressedPatch> {
    const chunkSize = options.chunkSize ?? this.defaultChunkSize
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError(`Invalid chunkSize: ${String(chunkSize)}. Must be a positive integer.`)
    }

    const algorithm = options.algorithm ?? this.defaultAlgorithm
    const filePath = options.filePath ?? 'artifact.bin'
    const signingSecret = options.signingSecret ?? this.defaultSigningSecret
    const keyId = options.keyId ?? this.defaultKeyId

    const hunks: BinaryChunkDigest[] = []
    let chunkIndex = 0

    for (let offset = 0; offset < targetBuffer.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, targetBuffer.length)
      const targetSlice = targetBuffer.subarray(offset, end)
      const baseSlice =
        offset < baseBuffer.length
          ? baseBuffer.subarray(offset, Math.min(end, baseBuffer.length))
          : Buffer.alloc(0)

      const hunk = await encodeSingleHunk({
        chunkIndex,
        offset,
        baseSlice,
        targetSlice,
        algorithm,
      })
      hunks.push(hunk)
      chunkIndex += 1
    }

    return this.assemblePatchManifest({
      filePath,
      algorithm,
      chunkSize,
      baseTotalBytes: baseBuffer.length,
      targetTotalBytes: targetBuffer.length,
      baseSha256: sha256Buffer(baseBuffer),
      targetSha256: sha256Buffer(targetBuffer),
      hunks,
      signingSecret,
      keyId,
    })
  }

  /**
   * Stream-compresses chunks incrementally from a Readable binary stream against an optional
   * base buffer, without buffering the full target payload prior to compression/hashing.
   */
  async compressStream(
    targetStream: Readable,
    baseBuffer: Buffer = Buffer.alloc(0),
    options: CompressDiffOptions = {},
  ): Promise<CompressedPatch> {
    const chunkSize = options.chunkSize ?? this.defaultChunkSize
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new RangeError(`Invalid chunkSize: ${String(chunkSize)}. Must be a positive integer.`)
    }

    const algorithm = options.algorithm ?? this.defaultAlgorithm
    const filePath = options.filePath ?? 'stream-artifact.bin'
    const signingSecret = options.signingSecret ?? this.defaultSigningSecret
    const keyId = options.keyId ?? this.defaultKeyId

    const targetHasher = createHash('sha256')
    const hunks: BinaryChunkDigest[] = []
    let pending: Buffer = Buffer.alloc(0)
    let offset = 0
    let chunkIndex = 0
    let targetTotalBytes = 0

    for await (const rawChunk of targetStream) {
      const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array)
      targetHasher.update(buf)
      targetTotalBytes += buf.length
      pending = pending.length === 0 ? buf : Buffer.concat([pending, buf])

      while (pending.length >= chunkSize) {
        const targetSlice = pending.subarray(0, chunkSize)
        pending = pending.subarray(chunkSize)

        const baseSlice =
          offset < baseBuffer.length
            ? baseBuffer.subarray(offset, Math.min(offset + targetSlice.length, baseBuffer.length))
            : Buffer.alloc(0)

        const hunk = await encodeSingleHunk({
          chunkIndex,
          offset,
          baseSlice,
          targetSlice,
          algorithm,
        })
        hunks.push(hunk)
        offset += targetSlice.length
        chunkIndex += 1
      }
    }

    if (pending.length > 0) {
      const targetSlice = pending
      const baseSlice =
        offset < baseBuffer.length
          ? baseBuffer.subarray(offset, Math.min(offset + targetSlice.length, baseBuffer.length))
          : Buffer.alloc(0)

      const hunk = await encodeSingleHunk({
        chunkIndex,
        offset,
        baseSlice,
        targetSlice,
        algorithm,
      })
      hunks.push(hunk)
    }

    return this.assemblePatchManifest({
      filePath,
      algorithm,
      chunkSize,
      baseTotalBytes: baseBuffer.length,
      targetTotalBytes,
      baseSha256: sha256Buffer(baseBuffer),
      targetSha256: targetHasher.digest('hex'),
      hunks,
      signingSecret,
      keyId,
    })
  }

  /**
   * Verifies every chunk payload digest, the canonical manifest content-digest,
   * and the cryptographic signature envelope (fail-closed Axiom A2).
   */
  verifyPatchSignature(
    patch: CompressedPatch,
    options: VerifyPatchOptions = {},
  ): PatchVerificationResult {
    const errors: string[] = []
    const invalidChunkIndices: number[] = []

    for (let i = 0; i < patch.hunks.length; i += 1) {
      const hunk = patch.hunks[i]
      if (!hunk) continue

      if (hunk.chunkIndex !== i) {
        invalidChunkIndices.push(hunk.chunkIndex)
        errors.push(`Chunk index sequence mismatch at position ${String(i)}`)
        continue
      }

      const rawPayload = Buffer.from(hunk.payloadBase64, 'base64')
      if (rawPayload.length !== hunk.compressedLength) {
        invalidChunkIndices.push(hunk.chunkIndex)
        errors.push(
          `Chunk ${String(hunk.chunkIndex)} length mismatch: expected ${String(hunk.compressedLength)}, got ${String(rawPayload.length)}`,
        )
        continue
      }

      const actualPayloadSha = sha256Buffer(rawPayload)
      if (!timingSafeHexEqual(hunk.compressedPayloadSha256, actualPayloadSha)) {
        invalidChunkIndices.push(hunk.chunkIndex)
        errors.push(`Chunk ${String(hunk.chunkIndex)} payload SHA-256 mismatch`)
      }
    }

    const chunkDigestsValid = invalidChunkIndices.length === 0

    const expectedManifestDigest = computeCanonicalManifestDigest({
      patchId: patch.patchId,
      filePath: patch.filePath,
      algorithm: patch.algorithm,
      chunkSize: patch.chunkSize,
      baseTotalBytes: patch.baseTotalBytes,
      targetTotalBytes: patch.targetTotalBytes,
      baseSha256: patch.baseSha256,
      targetSha256: patch.targetSha256,
      hunks: patch.hunks,
    })

    const manifestDigestMatch = timingSafeHexEqual(
      expectedManifestDigest,
      patch.signatureEnvelope.manifestContentDigest,
    )
    if (!manifestDigestMatch) {
      errors.push('Canonical manifest content-digest mismatch: patch metadata was altered')
    }

    const signingSecret = options.signingSecret ?? this.defaultSigningSecret
    let signatureValid = false

    if (patch.signatureEnvelope.signatureAlgorithm === 'hmac-sha256') {
      if (signingSecret === undefined) {
        errors.push('HMAC-SHA256 patch requires a signingSecret for verification')
      } else {
        const expectedSig = computeEnvelopeSignature(
          patch.signatureEnvelope.manifestContentDigest,
          signingSecret,
        )
        signatureValid = timingSafeHexEqual(
          expectedSig.signature,
          patch.signatureEnvelope.signature,
        )
        if (!signatureValid) {
          errors.push('HMAC-SHA256 signature verification failed')
        }
      }
    } else {
      const expectedSig = computeEnvelopeSignature(
        patch.signatureEnvelope.manifestContentDigest,
        undefined,
      )
      signatureValid = timingSafeHexEqual(expectedSig.signature, patch.signatureEnvelope.signature)
      if (!signatureValid) {
        errors.push('SHA-256 digest signature verification failed')
      }
    }

    return {
      valid: chunkDigestsValid && manifestDigestMatch && signatureValid,
      patchId: patch.patchId,
      signatureValid,
      manifestDigestMatch,
      chunkDigestsValid,
      invalidChunkIndices,
      errors,
    }
  }

  /**
   * Decompresses and reconstructs the target binary buffer against `baseBuffer`,
   * enforcing signature validity, base SHA-256 match, and per-chunk / full-file
   * SHA-256 fidelity verification.
   */
  async decompressPatch(
    patch: CompressedPatch,
    baseBuffer: Buffer = Buffer.alloc(0),
    options: DecompressPatchOptions = {},
  ): Promise<DecompressionResult> {
    const verifySignature = options.verifySignature ?? true
    const verification = this.verifyPatchSignature(patch, {
      signingSecret: options.signingSecret,
    })

    if (verifySignature && !verification.valid) {
      return {
        success: false,
        patchId: patch.patchId,
        filePath: patch.filePath,
        outputBuffer: Buffer.alloc(0),
        reconstructedBytes: 0,
        reconstructedSha256: sha256Buffer(Buffer.alloc(0)),
        expectedTargetSha256: patch.targetSha256,
        fidelityVerified: false,
        verification,
        error: verification.errors.join('; '),
      }
    }

    const actualBaseSha = sha256Buffer(baseBuffer)
    if (!timingSafeHexEqual(patch.baseSha256, actualBaseSha)) {
      return {
        success: false,
        patchId: patch.patchId,
        filePath: patch.filePath,
        outputBuffer: Buffer.alloc(0),
        reconstructedBytes: 0,
        reconstructedSha256: sha256Buffer(Buffer.alloc(0)),
        expectedTargetSha256: patch.targetSha256,
        fidelityVerified: false,
        verification,
        error: `Base buffer SHA-256 mismatch: expected ${patch.baseSha256}, got ${actualBaseSha}`,
      }
    }

    const reconstructedChunks: Buffer[] = []

    try {
      for (const hunk of patch.hunks) {
        let targetChunk: Buffer

        if (hunk.operation === 'COPY') {
          targetChunk = baseBuffer.subarray(hunk.offset, hunk.offset + hunk.originalLength)
        } else if (hunk.operation === 'XOR_DELTA') {
          const compressed = Buffer.from(hunk.payloadBase64, 'base64')
          const delta = await decompressBufferViaStream(compressed, patch.algorithm)
          const baseSlice = baseBuffer.subarray(hunk.offset, hunk.offset + hunk.originalLength)
          if (delta.length !== baseSlice.length || delta.length !== hunk.originalLength) {
            return {
              success: false,
              patchId: patch.patchId,
              filePath: patch.filePath,
              outputBuffer: Buffer.alloc(0),
              reconstructedBytes: 0,
              reconstructedSha256: sha256Buffer(Buffer.alloc(0)),
              expectedTargetSha256: patch.targetSha256,
              fidelityVerified: false,
              verification,
              error: `XOR delta size mismatch at chunk ${String(hunk.chunkIndex)}`,
            }
          }
          targetChunk = xorBuffers(baseSlice, delta)
        } else {
          const compressed = Buffer.from(hunk.payloadBase64, 'base64')
          targetChunk = await decompressBufferViaStream(compressed, patch.algorithm)
        }

        const chunkSha = sha256Buffer(targetChunk)
        if (!timingSafeHexEqual(hunk.targetChunkSha256, chunkSha)) {
          return {
            success: false,
            patchId: patch.patchId,
            filePath: patch.filePath,
            outputBuffer: Buffer.alloc(0),
            reconstructedBytes: 0,
            reconstructedSha256: sha256Buffer(Buffer.alloc(0)),
            expectedTargetSha256: patch.targetSha256,
            fidelityVerified: false,
            verification,
            error: `Reconstructed chunk ${String(hunk.chunkIndex)} SHA-256 verification failed`,
          }
        }

        reconstructedChunks.push(targetChunk)
      }
    } catch (err) {
      return {
        success: false,
        patchId: patch.patchId,
        filePath: patch.filePath,
        outputBuffer: Buffer.alloc(0),
        reconstructedBytes: 0,
        reconstructedSha256: sha256Buffer(Buffer.alloc(0)),
        expectedTargetSha256: patch.targetSha256,
        fidelityVerified: false,
        verification,
        error: `Decompression failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const outputBuffer = Buffer.concat(reconstructedChunks)
    const reconstructedSha256 = sha256Buffer(outputBuffer)
    const fidelityVerified =
      outputBuffer.length === patch.targetTotalBytes &&
      timingSafeHexEqual(patch.targetSha256, reconstructedSha256)

    return {
      success: fidelityVerified,
      patchId: patch.patchId,
      filePath: patch.filePath,
      outputBuffer,
      reconstructedBytes: outputBuffer.length,
      reconstructedSha256,
      expectedTargetSha256: patch.targetSha256,
      fidelityVerified,
      verification,
      ...(fidelityVerified
        ? {}
        : {
            error: `Target output hash/length mismatch: expected ${patch.targetSha256}, got ${reconstructedSha256}`,
          }),
    }
  }

  /**
   * Strict exception-throwing variant of `decompressPatch`.
   */
  async decompressPatchStrict(
    patch: CompressedPatch,
    baseBuffer: Buffer = Buffer.alloc(0),
    options: DecompressPatchOptions = {},
  ): Promise<DecompressionResult> {
    const verifySignature = options.verifySignature ?? true
    const verification = this.verifyPatchSignature(patch, {
      signingSecret: options.signingSecret,
    })

    if (verifySignature && !verification.valid) {
      throw new BinaryPatchSignatureError(patch.patchId, verification.errors.join('; '))
    }

    const actualBaseSha = sha256Buffer(baseBuffer)
    if (!timingSafeHexEqual(patch.baseSha256, actualBaseSha)) {
      throw new BinaryPatchBaseMismatchError(patch.patchId, patch.baseSha256, actualBaseSha)
    }

    const result = await this.decompressPatch(patch, baseBuffer, options)
    if (!result.success) {
      throw new BinaryPatchCorruptionError(
        patch.patchId,
        result.error ?? 'Failed fidelity check during decompression',
      )
    }

    return result
  }

  private assemblePatchManifest(params: {
    readonly filePath: string
    readonly algorithm: CompressionAlgorithm
    readonly chunkSize: number
    readonly baseTotalBytes: number
    readonly targetTotalBytes: number
    readonly baseSha256: string
    readonly targetSha256: string
    readonly hunks: readonly BinaryChunkDigest[]
    readonly signingSecret?: string | undefined
    readonly keyId?: string | undefined
  }): CompressedPatch {
    const patchId = `bpatch-${randomUUID().slice(0, 12)}`
    const totalCompressedBytes = params.hunks.reduce((sum, h) => sum + h.compressedLength, 0)
    const totalOriginalBytes = params.targetTotalBytes
    const compressionRatio =
      totalOriginalBytes > 0 ? Number((totalCompressedBytes / totalOriginalBytes).toFixed(4)) : 1
    const spaceSavingsPercent =
      totalOriginalBytes > 0
        ? Number(
            (((totalOriginalBytes - totalCompressedBytes) / totalOriginalBytes) * 100).toFixed(2),
          )
        : 0

    let copiedChunksCount = 0
    let deltaChunksCount = 0
    let replacedChunksCount = 0
    for (const h of params.hunks) {
      if (h.operation === 'COPY') copiedChunksCount += 1
      else if (h.operation === 'XOR_DELTA') deltaChunksCount += 1
      else replacedChunksCount += 1
    }

    const manifestContentDigest = computeCanonicalManifestDigest({
      patchId,
      filePath: params.filePath,
      algorithm: params.algorithm,
      chunkSize: params.chunkSize,
      baseTotalBytes: params.baseTotalBytes,
      targetTotalBytes: params.targetTotalBytes,
      baseSha256: params.baseSha256,
      targetSha256: params.targetSha256,
      hunks: params.hunks,
    })

    const { signatureAlgorithm, signature } = computeEnvelopeSignature(
      manifestContentDigest,
      params.signingSecret,
    )

    const signatureEnvelope: PatchSignatureEnvelope = {
      signatureVersion: '1.0',
      digestAlgorithm: 'sha256',
      signatureAlgorithm,
      manifestContentDigest,
      signature,
      ...(params.keyId !== undefined ? { keyId: params.keyId } : {}),
      signedAt: Date.now(),
    }

    return {
      patchId,
      filePath: params.filePath,
      algorithm: params.algorithm,
      chunkSize: params.chunkSize,
      baseTotalBytes: params.baseTotalBytes,
      targetTotalBytes: params.targetTotalBytes,
      baseSha256: params.baseSha256,
      targetSha256: params.targetSha256,
      totalOriginalBytes,
      totalCompressedBytes,
      compressionRatio,
      spaceSavingsPercent,
      hunkCount: params.hunks.length,
      copiedChunksCount,
      deltaChunksCount,
      replacedChunksCount,
      hunks: params.hunks,
      signatureEnvelope,
    }
  }
}
