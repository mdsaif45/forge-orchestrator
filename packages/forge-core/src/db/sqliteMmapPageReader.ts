/**
 * STATE-030: SQLite Zero-Copy Memory-Mapped File Page Reader.
 *
 * Provides fast, boundary-checked, zero-copy page-level inspection of SQLite
 * database files and Write-Ahead Log (WAL) frame sequences via Buffer.subarray
 * views without allocating redundant page copies (Axioms A1, A2, A4).
 */

import { readFile } from 'node:fs/promises'

export const SQLITE_DB_MAGIC = 'SQLite format 3\0'
export const SQLITE_DB_HEADER_BYTES = 100
export const SQLITE_WAL_MAGIC_LE = 0x377f0682
export const SQLITE_WAL_MAGIC_BE = 0x377f0683
export const SQLITE_WAL_FORMAT_VERSION = 3007000
export const SQLITE_WAL_HEADER_BYTES = 32
export const SQLITE_WAL_FRAME_HEADER_BYTES = 24

export type BTreePageType =
  | 'INTERIOR_INDEX'
  | 'INTERIOR_TABLE'
  | 'LEAF_INDEX'
  | 'LEAF_TABLE'
  | 'OVERFLOW_OR_FREELIST'
  | 'UNKNOWN'

export type SqliteFileKind = 'SQLITE_DB' | 'SQLITE_WAL' | 'UNKNOWN'

export interface DatabaseFileHeader {
  readonly magicValid: boolean
  readonly magicString: string
  readonly pageSize: number
  readonly writeVersion: number
  readonly readVersion: number
  readonly reservedBytesPerPage: number
  readonly fileChangeCounter: number
  readonly databaseSizePages: number
  readonly firstFreelistTrunkPage: number
  readonly totalFreelistPages: number
  readonly schemaCookie: number
  readonly schemaFormat: number
  readonly textEncoding: 'UTF-8' | 'UTF-16le' | 'UTF-16be' | 'UNKNOWN'
  readonly userVersion: number
  readonly sqliteVersionNumber: number
}

export interface PageHeader {
  readonly pageNumber: number
  readonly offsetBytes: number
  readonly pageSizeBytes: number
  readonly rawPageType: number
  readonly pageType: BTreePageType
  readonly firstFreeblockOffset: number
  readonly cellCount: number
  readonly cellContentStartOffset: number
  readonly fragmentedFreeBytes: number
  readonly rightMostPointer?: number | undefined
}

export interface ZeroCopyPageSlice {
  readonly header: PageHeader
  readonly pageView: Buffer
  readonly isZeroCopyView: boolean
}

export interface WalHeader {
  readonly magicNumber: number
  readonly endianness: 'little' | 'big'
  readonly formatVersion: number
  readonly pageSize: number
  readonly checkpointSequence: number
  readonly salt1: number
  readonly salt2: number
  readonly checksum1: number
  readonly checksum2: number
  readonly headerChecksumValid: boolean
}

export interface WalFrameView {
  readonly frameIndex: number
  readonly frameOffsetBytes: number
  readonly pageNumber: number
  readonly dbSizeAfterCommitPages: number
  readonly isCommitFrame: boolean
  readonly salt1: number
  readonly salt2: number
  readonly checksum1: number
  readonly checksum2: number
  readonly saltMatch: boolean
  readonly checksumValid: boolean
  readonly pageView: Buffer
}

export interface WalInspectionReport {
  readonly valid: boolean
  readonly header: WalHeader
  readonly totalFrames: number
  readonly validFramesCount: number
  readonly commitFramesCount: number
  readonly corruptFrameIndices: readonly number[]
  readonly frames: readonly WalFrameView[]
  readonly trailingBytes: number
  readonly errors: readonly string[]
}

export interface MmapDatabaseInspectionReport {
  readonly valid: boolean
  readonly source: string
  readonly kind: SqliteFileKind
  readonly totalBytes: number
  readonly pageSize: number
  readonly pageOrFrameCount: number
  readonly validItemsCount: number
  readonly corruptItemsCount: number
  readonly zeroCopyVerified: boolean
  readonly dbHeader?: DatabaseFileHeader | undefined
  readonly walHeader?: WalHeader | undefined
  readonly samplePages?: readonly PageHeader[] | undefined
  readonly walFrames?: readonly Omit<WalFrameView, 'pageView'>[] | undefined
  readonly errors: readonly string[]
}

export class MmapBoundaryError extends RangeError {
  constructor(message: string) {
    super(`Mmap memory boundary violation: ${message}`)
    this.name = 'MmapBoundaryError'
  }
}

export class MmapInvalidMagicError extends Error {
  constructor(message: string) {
    super(`Invalid SQLite/WAL magic header: ${message}`)
    this.name = 'MmapInvalidMagicError'
  }
}

export class MmapCorruptFrameError extends Error {
  constructor(frameIndex: number, details: string) {
    super(`Corrupt SQLite WAL frame #${String(frameIndex)}: ${details}`)
    this.name = 'MmapCorruptFrameError'
  }
}

function resolvePageType(flag: number): BTreePageType {
  switch (flag) {
    case 0x02:
      return 'INTERIOR_INDEX'
    case 0x05:
      return 'INTERIOR_TABLE'
    case 0x0a:
      return 'LEAF_INDEX'
    case 0x0d:
      return 'LEAF_TABLE'
    case 0x00:
      return 'OVERFLOW_OR_FREELIST'
    default:
      return 'UNKNOWN'
  }
}

function resolveTextEncoding(code: number): DatabaseFileHeader['textEncoding'] {
  switch (code) {
    case 1:
      return 'UTF-8'
    case 2:
      return 'UTF-16le'
    case 3:
      return 'UTF-16be'
    default:
      return 'UNKNOWN'
  }
}

function isValidPageSize(pageSize: number): boolean {
  return (
    Number.isInteger(pageSize) &&
    pageSize >= 512 &&
    pageSize <= 65536 &&
    (pageSize & (pageSize - 1)) === 0
  )
}

/**
 * Computes SQLite's cumulative 64-bit (two 32-bit word) WAL checksum over an 8-byte-aligned buffer.
 */
export function computeWalChecksum(
  data: Buffer,
  endianness: 'little' | 'big',
  initialChecksum: readonly [number, number] = [0, 0],
): readonly [number, number] {
  if (data.length % 8 !== 0) {
    throw new MmapBoundaryError(
      `WAL checksum buffer length (${String(data.length)}) must be a multiple of 8 bytes`,
    )
  }

  let s0 = initialChecksum[0] >>> 0
  let s1 = initialChecksum[1] >>> 0

  for (let offset = 0; offset < data.length; offset += 8) {
    const x0 = endianness === 'little' ? data.readUInt32LE(offset) : data.readUInt32BE(offset)
    const x1 =
      endianness === 'little' ? data.readUInt32LE(offset + 4) : data.readUInt32BE(offset + 4)

    s0 = (s0 + x0 + s1) >>> 0
    s1 = (s1 + x1 + s0) >>> 0
  }

  return [s0, s1]
}

export class SqliteMmapPageReader {
  private readonly backingBuffer: Buffer
  private readonly sourceLabel: string

  private constructor(backingBuffer: Buffer, sourceLabel: string) {
    this.backingBuffer = backingBuffer
    this.sourceLabel = sourceLabel
  }

  /**
   * Maps an on-disk SQLite database or WAL file into a single contiguous backing Buffer
   * so all subsequent page and frame accesses operate as zero-copy Buffer.subarray views.
   */
  static async fromFile(filePath: string): Promise<SqliteMmapPageReader> {
    const buffer = await readFile(filePath)
    return new SqliteMmapPageReader(buffer, filePath)
  }

  /**
   * Wraps an existing Buffer directly without copying bytes.
   */
  static fromBuffer(buffer: Buffer, sourceLabel = '<buffer>'): SqliteMmapPageReader {
    return new SqliteMmapPageReader(buffer, sourceLabel)
  }

  get byteLength(): number {
    return this.backingBuffer.length
  }

  detectFileKind(): SqliteFileKind {
    if (this.backingBuffer.length >= SQLITE_DB_MAGIC.length) {
      const prefix = this.backingBuffer.subarray(0, SQLITE_DB_MAGIC.length).toString('utf8')
      if (prefix === SQLITE_DB_MAGIC) {
        return 'SQLITE_DB'
      }
    }

    if (this.backingBuffer.length >= 4) {
      const magic = this.backingBuffer.readUInt32BE(0)
      if (magic === SQLITE_WAL_MAGIC_LE || magic === SQLITE_WAL_MAGIC_BE) {
        return 'SQLITE_WAL'
      }
    }

    return 'UNKNOWN'
  }

  /**
   * Decodes the 100-byte SQLite3 database file header (Page 1 bytes 0..99).
   */
  readDatabaseHeader(): DatabaseFileHeader {
    if (this.backingBuffer.length < SQLITE_DB_HEADER_BYTES) {
      throw new MmapBoundaryError(
        `SQLite database requires at least ${String(SQLITE_DB_HEADER_BYTES)} bytes for header, got ${String(this.backingBuffer.length)}`,
      )
    }

    const magicString = this.backingBuffer.subarray(0, SQLITE_DB_MAGIC.length).toString('utf8')
    if (magicString !== SQLITE_DB_MAGIC) {
      throw new MmapInvalidMagicError(
        `Expected "${SQLITE_DB_MAGIC.replace('\0', '\\0')}", got "${magicString}"`,
      )
    }

    const rawPageSize = this.backingBuffer.readUInt16BE(16)
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
    if (!isValidPageSize(pageSize)) {
      throw new MmapInvalidMagicError(`Invalid SQLite page size: ${String(pageSize)}`)
    }

    return {
      magicValid: true,
      magicString: 'SQLite format 3',
      pageSize,
      writeVersion: this.backingBuffer.readUInt8(18),
      readVersion: this.backingBuffer.readUInt8(19),
      reservedBytesPerPage: this.backingBuffer.readUInt8(20),
      fileChangeCounter: this.backingBuffer.readUInt32BE(24),
      databaseSizePages: this.backingBuffer.readUInt32BE(28),
      firstFreelistTrunkPage: this.backingBuffer.readUInt32BE(32),
      totalFreelistPages: this.backingBuffer.readUInt32BE(36),
      schemaCookie: this.backingBuffer.readUInt32BE(40),
      schemaFormat: this.backingBuffer.readUInt32BE(44),
      textEncoding: resolveTextEncoding(this.backingBuffer.readUInt32BE(56)),
      userVersion: this.backingBuffer.readUInt32BE(60),
      sqliteVersionNumber: this.backingBuffer.readUInt32BE(96),
    }
  }

  /**
   * Returns a zero-copy Buffer view and decoded B-tree PageHeader for 1-based `pageNumber`.
   */
  readPage(pageNumber: number): ZeroCopyPageSlice {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new MmapBoundaryError(
        `Page number must be a positive integer >= 1, got ${String(pageNumber)}`,
      )
    }

    const dbHeader = this.readDatabaseHeader()
    const pageSize = dbHeader.pageSize
    const offsetBytes = (pageNumber - 1) * pageSize
    const endOffset = offsetBytes + pageSize

    if (endOffset > this.backingBuffer.length) {
      throw new MmapBoundaryError(
        `Page ${String(pageNumber)} (bytes ${String(offsetBytes)}..${String(endOffset)}) exceeds mapped buffer size (${String(this.backingBuffer.length)})`,
      )
    }

    // Zero-copy slice into the backing slab
    const pageView = this.backingBuffer.subarray(offsetBytes, endOffset)
    const btreeOffset = pageNumber === 1 ? SQLITE_DB_HEADER_BYTES : 0

    const rawPageType = pageView.readUInt8(btreeOffset)
    const pageType = resolvePageType(rawPageType)
    const firstFreeblockOffset = pageView.readUInt16BE(btreeOffset + 1)
    const cellCount = pageView.readUInt16BE(btreeOffset + 3)
    const rawCellContentStart = pageView.readUInt16BE(btreeOffset + 5)
    const cellContentStartOffset = rawCellContentStart === 0 ? 65536 : rawCellContentStart
    const fragmentedFreeBytes = pageView.readUInt8(btreeOffset + 7)
    const isInterior = pageType === 'INTERIOR_INDEX' || pageType === 'INTERIOR_TABLE'
    const rightMostPointer = isInterior ? pageView.readUInt32BE(btreeOffset + 8) : undefined

    const header: PageHeader = {
      pageNumber,
      offsetBytes,
      pageSizeBytes: pageSize,
      rawPageType,
      pageType,
      firstFreeblockOffset,
      cellCount,
      cellContentStartOffset,
      fragmentedFreeBytes,
      ...(rightMostPointer !== undefined ? { rightMostPointer } : {}),
    }

    return {
      header,
      pageView,
      isZeroCopyView: pageView.buffer === this.backingBuffer.buffer,
    }
  }

  /**
   * Decodes the 32-byte SQLite WAL header and validates magic number, format version, and header checksum.
   */
  readWalHeader(): WalHeader {
    if (this.backingBuffer.length < SQLITE_WAL_HEADER_BYTES) {
      throw new MmapBoundaryError(
        `SQLite WAL requires at least ${String(SQLITE_WAL_HEADER_BYTES)} bytes for header, got ${String(this.backingBuffer.length)}`,
      )
    }

    const magicNumber = this.backingBuffer.readUInt32BE(0)
    if (magicNumber !== SQLITE_WAL_MAGIC_LE && magicNumber !== SQLITE_WAL_MAGIC_BE) {
      throw new MmapInvalidMagicError(
        `Expected WAL magic 0x377f0682 or 0x377f0683, got 0x${magicNumber.toString(16)}`,
      )
    }

    const endianness: 'little' | 'big' = magicNumber === SQLITE_WAL_MAGIC_LE ? 'little' : 'big'
    const formatVersion = this.backingBuffer.readUInt32BE(4)
    if (formatVersion !== SQLITE_WAL_FORMAT_VERSION) {
      throw new MmapInvalidMagicError(
        `Unsupported WAL format version: ${String(formatVersion)} (expected ${String(SQLITE_WAL_FORMAT_VERSION)})`,
      )
    }

    const pageSize = this.backingBuffer.readUInt32BE(8)
    if (!isValidPageSize(pageSize)) {
      throw new MmapInvalidMagicError(`Invalid WAL page size: ${String(pageSize)}`)
    }

    const checkpointSequence = this.backingBuffer.readUInt32BE(12)
    const salt1 = this.backingBuffer.readUInt32BE(16)
    const salt2 = this.backingBuffer.readUInt32BE(20)
    const checksum1 = this.backingBuffer.readUInt32BE(24)
    const checksum2 = this.backingBuffer.readUInt32BE(28)

    const [expectedS0, expectedS1] = computeWalChecksum(
      this.backingBuffer.subarray(0, 24),
      endianness,
      [0, 0],
    )
    const headerChecksumValid = checksum1 === expectedS0 && checksum2 === expectedS1

    return {
      magicNumber,
      endianness,
      formatVersion,
      pageSize,
      checkpointSequence,
      salt1,
      salt2,
      checksum1,
      checksum2,
      headerChecksumValid,
    }
  }

  /**
   * Scans all WAL frames using zero-copy Buffer.subarray views, validating salts and
   * SQLite's cumulative 64-bit checksum chain across every frame.
   */
  inspectWalFrames(): WalInspectionReport {
    const header = this.readWalHeader()
    const errors: string[] = []
    if (!header.headerChecksumValid) {
      errors.push('WAL header checksum mismatch')
    }

    const frameStride = SQLITE_WAL_FRAME_HEADER_BYTES + header.pageSize
    const dataLength = this.backingBuffer.length - SQLITE_WAL_HEADER_BYTES
    const totalFrames = Math.floor(dataLength / frameStride)
    const trailingBytes = dataLength % frameStride

    if (trailingBytes > 0) {
      errors.push(
        `Detected ${String(trailingBytes)} truncated trailing bytes after frame #${String(totalFrames - 1)}`,
      )
    }

    const frames: WalFrameView[] = []
    const corruptFrameIndices: number[] = []
    let commitFramesCount = 0
    let runningChecksum: readonly [number, number] = [header.checksum1, header.checksum2]

    for (let i = 0; i < totalFrames; i += 1) {
      const frameOffsetBytes = SQLITE_WAL_HEADER_BYTES + i * frameStride
      const frameHeaderSlice = this.backingBuffer.subarray(
        frameOffsetBytes,
        frameOffsetBytes + SQLITE_WAL_FRAME_HEADER_BYTES,
      )
      const pageOffset = frameOffsetBytes + SQLITE_WAL_FRAME_HEADER_BYTES
      const pageView = this.backingBuffer.subarray(pageOffset, pageOffset + header.pageSize)

      const pageNumber = frameHeaderSlice.readUInt32BE(0)
      const dbSizeAfterCommitPages = frameHeaderSlice.readUInt32BE(4)
      const salt1 = frameHeaderSlice.readUInt32BE(8)
      const salt2 = frameHeaderSlice.readUInt32BE(12)
      const checksum1 = frameHeaderSlice.readUInt32BE(16)
      const checksum2 = frameHeaderSlice.readUInt32BE(20)

      const saltMatch = salt1 === header.salt1 && salt2 === header.salt2
      const afterMetaChecksum = computeWalChecksum(
        frameHeaderSlice.subarray(0, 8),
        header.endianness,
        runningChecksum,
      )
      const [expectedS0, expectedS1] = computeWalChecksum(
        pageView,
        header.endianness,
        afterMetaChecksum,
      )
      const checksumValid = checksum1 === expectedS0 && checksum2 === expectedS1

      if (!saltMatch || !checksumValid) {
        corruptFrameIndices.push(i)
        if (!saltMatch) {
          errors.push(`Frame #${String(i)} salt mismatch (stale or cross-epoch frame)`)
        }
        if (!checksumValid) {
          errors.push(`Frame #${String(i)} cumulative checksum mismatch`)
        }
      }

      if (dbSizeAfterCommitPages > 0) {
        commitFramesCount += 1
      }

      runningChecksum = [expectedS0, expectedS1]

      frames.push({
        frameIndex: i,
        frameOffsetBytes,
        pageNumber,
        dbSizeAfterCommitPages,
        isCommitFrame: dbSizeAfterCommitPages > 0,
        salt1,
        salt2,
        checksum1,
        checksum2,
        saltMatch,
        checksumValid,
        pageView,
      })
    }

    const validFramesCount = frames.length - corruptFrameIndices.length

    return {
      valid: header.headerChecksumValid && corruptFrameIndices.length === 0 && trailingBytes === 0,
      header,
      totalFrames,
      validFramesCount,
      commitFramesCount,
      corruptFrameIndices,
      frames,
      trailingBytes,
      errors,
    }
  }

  /**
   * Returns a single validated WAL frame view at 0-based `frameIndex`.
   */
  readWalFrame(frameIndex: number): WalFrameView {
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new MmapBoundaryError(`WAL frame index must be >= 0, got ${String(frameIndex)}`)
    }
    const report = this.inspectWalFrames()
    const frame = report.frames[frameIndex]
    if (!frame) {
      throw new MmapBoundaryError(
        `WAL frame index ${String(frameIndex)} out of bounds (total frames: ${String(report.totalFrames)})`,
      )
    }
    if (!frame.saltMatch || !frame.checksumValid) {
      throw new MmapCorruptFrameError(
        frameIndex,
        !frame.saltMatch ? 'Salt mismatch' : 'Checksum verification failed',
      )
    }
    return frame
  }

  /**
   * Auto-detects mapped file kind (SQLite DB or WAL) and generates an inspection summary.
   */
  inspect(maxSamplePages = 8): MmapDatabaseInspectionReport {
    const kind = this.detectFileKind()
    if (kind === 'UNKNOWN') {
      return {
        valid: false,
        source: this.sourceLabel,
        kind: 'UNKNOWN',
        totalBytes: this.backingBuffer.length,
        pageSize: 0,
        pageOrFrameCount: 0,
        validItemsCount: 0,
        corruptItemsCount: 0,
        zeroCopyVerified: false,
        errors: ['Unrecognized SQLite database or WAL file header magic'],
      }
    }

    if (kind === 'SQLITE_DB') {
      const errors: string[] = []
      let dbHeader: DatabaseFileHeader
      try {
        dbHeader = this.readDatabaseHeader()
      } catch (err) {
        return {
          valid: false,
          source: this.sourceLabel,
          kind,
          totalBytes: this.backingBuffer.length,
          pageSize: 0,
          pageOrFrameCount: 0,
          validItemsCount: 0,
          corruptItemsCount: 0,
          zeroCopyVerified: false,
          errors: [err instanceof Error ? err.message : String(err)],
        }
      }

      const physicalPageCount = Math.floor(this.backingBuffer.length / dbHeader.pageSize)
      const trailingBytes = this.backingBuffer.length % dbHeader.pageSize
      if (trailingBytes > 0) {
        errors.push(`Database file has ${String(trailingBytes)} partial page trailing bytes`)
      }

      const sampleCount = Math.min(physicalPageCount, Math.max(1, maxSamplePages))
      const samplePages: PageHeader[] = []
      let zeroCopyVerified = physicalPageCount === 0

      for (let p = 1; p <= sampleCount; p += 1) {
        const slice = this.readPage(p)
        samplePages.push(slice.header)
        zeroCopyVerified = slice.isZeroCopyView
      }

      return {
        valid: errors.length === 0 && physicalPageCount >= 1,
        source: this.sourceLabel,
        kind,
        totalBytes: this.backingBuffer.length,
        pageSize: dbHeader.pageSize,
        pageOrFrameCount: physicalPageCount,
        validItemsCount: physicalPageCount,
        corruptItemsCount: 0,
        zeroCopyVerified,
        dbHeader,
        samplePages,
        errors,
      }
    }

    // SQLITE_WAL
    try {
      const walReport = this.inspectWalFrames()
      const zeroCopyVerified =
        walReport.frames.length === 0 ||
        walReport.frames.every((f) => f.pageView.buffer === this.backingBuffer.buffer)

      return {
        valid: walReport.valid,
        source: this.sourceLabel,
        kind,
        totalBytes: this.backingBuffer.length,
        pageSize: walReport.header.pageSize,
        pageOrFrameCount: walReport.totalFrames,
        validItemsCount: walReport.validFramesCount,
        corruptItemsCount: walReport.corruptFrameIndices.length,
        zeroCopyVerified,
        walHeader: walReport.header,
        walFrames: walReport.frames.map((f) => ({
          frameIndex: f.frameIndex,
          frameOffsetBytes: f.frameOffsetBytes,
          pageNumber: f.pageNumber,
          dbSizeAfterCommitPages: f.dbSizeAfterCommitPages,
          isCommitFrame: f.isCommitFrame,
          salt1: f.salt1,
          salt2: f.salt2,
          checksum1: f.checksum1,
          checksum2: f.checksum2,
          saltMatch: f.saltMatch,
          checksumValid: f.checksumValid,
        })),
        errors: walReport.errors,
      }
    } catch (err) {
      return {
        valid: false,
        source: this.sourceLabel,
        kind,
        totalBytes: this.backingBuffer.length,
        pageSize: 0,
        pageOrFrameCount: 0,
        validItemsCount: 0,
        corruptItemsCount: 0,
        zeroCopyVerified: false,
        errors: [err instanceof Error ? err.message : String(err)],
      }
    }
  }
}
