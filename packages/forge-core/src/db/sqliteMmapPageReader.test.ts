import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeWalChecksum,
  MmapBoundaryError,
  MmapCorruptFrameError,
  MmapInvalidMagicError,
  SQLITE_WAL_FORMAT_VERSION,
  SQLITE_WAL_FRAME_HEADER_BYTES,
  SQLITE_WAL_HEADER_BYTES,
  SQLITE_WAL_MAGIC_BE,
  SQLITE_WAL_MAGIC_LE,
  SqliteMmapPageReader,
} from './sqliteMmapPageReader'

function buildSyntheticWalBuffer(options: {
  readonly magic?: number
  readonly pageSize?: number
  readonly salt1?: number
  readonly salt2?: number
  readonly frameCount?: number
}): Buffer {
  const magic = options.magic ?? SQLITE_WAL_MAGIC_LE
  const endianness: 'little' | 'big' = magic === SQLITE_WAL_MAGIC_LE ? 'little' : 'big'
  const pageSize = options.pageSize ?? 1024
  const salt1 = options.salt1 ?? 0x11223344
  const salt2 = options.salt2 ?? 0x55667788
  const frameCount = options.frameCount ?? 2

  const stride = SQLITE_WAL_FRAME_HEADER_BYTES + pageSize
  const totalBytes = SQLITE_WAL_HEADER_BYTES + frameCount * stride
  const buf = Buffer.alloc(totalBytes)

  buf.writeUInt32BE(magic, 0)
  buf.writeUInt32BE(SQLITE_WAL_FORMAT_VERSION, 4)
  buf.writeUInt32BE(pageSize, 8)
  buf.writeUInt32BE(1, 12)
  buf.writeUInt32BE(salt1, 16)
  buf.writeUInt32BE(salt2, 20)

  const [hdrS0, hdrS1] = computeWalChecksum(buf.subarray(0, 24), endianness, [0, 0])
  buf.writeUInt32BE(hdrS0, 24)
  buf.writeUInt32BE(hdrS1, 28)

  let running: readonly [number, number] = [hdrS0, hdrS1]
  for (let i = 0; i < frameCount; i += 1) {
    const offset = SQLITE_WAL_HEADER_BYTES + i * stride
    const frameHdr = buf.subarray(offset, offset + SQLITE_WAL_FRAME_HEADER_BYTES)
    const pageBuf = buf.subarray(
      offset + SQLITE_WAL_FRAME_HEADER_BYTES,
      offset + SQLITE_WAL_FRAME_HEADER_BYTES + pageSize,
    )

    frameHdr.writeUInt32BE(i + 1, 0) // pageNumber
    frameHdr.writeUInt32BE(i === frameCount - 1 ? i + 1 : 0, 4) // commit on last frame
    frameHdr.writeUInt32BE(salt1, 8)
    frameHdr.writeUInt32BE(salt2, 12)
    pageBuf.fill(0x20 + i)

    const afterMeta = computeWalChecksum(frameHdr.subarray(0, 8), endianness, running)
    const [s0, s1] = computeWalChecksum(pageBuf, endianness, afterMeta)
    frameHdr.writeUInt32BE(s0, 16)
    frameHdr.writeUInt32BE(s1, 20)
    running = [s0, s1]
  }

  return buf
}

describe('SqliteMmapPageReader (STATE-030)', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('decodes real SQLite database headers and zero-copy B-tree pages without extra buffer copies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-mmap-db-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'test.sqlite')

    const sqlite = new Database(dbPath)
    sqlite.pragma('page_size = 4096')
    sqlite.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT);')
    for (let i = 0; i < 40; i += 1) {
      sqlite.prepare('INSERT INTO items (body) VALUES (?)').run(`payload-row-${String(i)}`)
    }
    sqlite.close()

    const reader = await SqliteMmapPageReader.fromFile(dbPath)
    expect(reader.detectFileKind()).toBe('SQLITE_DB')

    const header = reader.readDatabaseHeader()
    expect(header.magicValid).toBe(true)
    expect(header.magicString).toBe('SQLite format 3')
    expect(header.pageSize).toBe(4096)
    expect(header.databaseSizePages).toBeGreaterThanOrEqual(2)
    expect(header.textEncoding).toBe('UTF-8')

    const page1 = reader.readPage(1)
    expect(page1.isZeroCopyView).toBe(true)
    expect(page1.pageView.length).toBe(4096)
    expect(page1.header.pageNumber).toBe(1)
    expect(page1.header.offsetBytes).toBe(0)
    expect(page1.header.pageType).toBe('LEAF_TABLE')
    expect(page1.header.cellCount).toBeGreaterThanOrEqual(1)

    const page2 = reader.readPage(2)
    expect(page2.isZeroCopyView).toBe(true)
    expect(page2.pageView.buffer).toBe(page1.pageView.buffer)
    expect(page2.pageView.byteOffset - page1.pageView.byteOffset).toBe(4096)

    const report = reader.inspect()
    expect(report.valid).toBe(true)
    expect(report.kind).toBe('SQLITE_DB')
    expect(report.zeroCopyVerified).toBe(true)
    expect(report.pageOrFrameCount).toBeGreaterThanOrEqual(2)
  })

  it('decodes and verifies real better-sqlite3 WAL frames on disk with cumulative checksums', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-mmap-wal-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'waltest.sqlite')
    const walPath = `${dbPath}-wal`

    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('wal_autocheckpoint = 0')
    sqlite.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, payload TEXT);')
    sqlite.prepare('INSERT INTO events (kind, payload) VALUES (?, ?)').run('STEP', 'data-1')
    sqlite.prepare('INSERT INTO events (kind, payload) VALUES (?, ?)').run('STEP', 'data-2')

    const walReader = await SqliteMmapPageReader.fromFile(walPath)
    expect(walReader.detectFileKind()).toBe('SQLITE_WAL')

    const walReport = walReader.inspectWalFrames()
    expect(walReport.valid).toBe(true)
    expect(walReport.header.headerChecksumValid).toBe(true)
    expect(walReport.totalFrames).toBeGreaterThanOrEqual(2)
    expect(walReport.validFramesCount).toBe(walReport.totalFrames)
    expect(walReport.commitFramesCount).toBeGreaterThanOrEqual(1)
    expect(walReport.corruptFrameIndices).toEqual([])
    expect(walReport.trailingBytes).toBe(0)

    const frame0 = walReader.readWalFrame(0)
    expect(frame0.checksumValid).toBe(true)
    expect(frame0.saltMatch).toBe(true)
    expect(frame0.pageView.length).toBe(walReport.header.pageSize)

    const inspection = walReader.inspect()
    expect(inspection.valid).toBe(true)
    expect(inspection.kind).toBe('SQLITE_WAL')
    expect(inspection.zeroCopyVerified).toBe(true)

    sqlite.close()
  })

  it('supports both little-endian and big-endian WAL checksum chains and verifies zero-copy views', () => {
    const beWal = buildSyntheticWalBuffer({
      magic: SQLITE_WAL_MAGIC_BE,
      pageSize: 512,
      frameCount: 3,
    })

    const reader = SqliteMmapPageReader.fromBuffer(beWal, 'synthetic-be.wal')
    const walReport = reader.inspectWalFrames()
    expect(walReport.valid).toBe(true)
    expect(walReport.header.endianness).toBe('big')
    expect(walReport.totalFrames).toBe(3)
    expect(walReport.commitFramesCount).toBe(1)

    for (const frame of walReport.frames) {
      expect(frame.pageView.buffer).toBe(beWal.buffer)
      expect(frame.checksumValid).toBe(true)
      expect(frame.saltMatch).toBe(true)
    }
  })

  it('detects corrupt WAL frames, salt mismatches, and truncated torn writes fail-closed', () => {
    // 1. Corrupt payload byte inside frame 1
    const corruptWal = buildSyntheticWalBuffer({ frameCount: 2 })
    const corruptOffset = SQLITE_WAL_HEADER_BYTES + SQLITE_WAL_FRAME_HEADER_BYTES + 100
    corruptWal[corruptOffset] = (corruptWal[corruptOffset] ?? 0) ^ 0xff

    const corruptReader = SqliteMmapPageReader.fromBuffer(corruptWal)
    const report1 = corruptReader.inspectWalFrames()
    expect(report1.valid).toBe(false)
    expect(report1.corruptFrameIndices).toContain(0)
    expect(report1.corruptFrameIndices).toContain(1) // cumulative checksum breaks downstream frame too
    expect(() => corruptReader.readWalFrame(0)).toThrow(MmapCorruptFrameError)

    // 2. Stale salt mismatch in frame 1
    const staleSaltWal = buildSyntheticWalBuffer({ frameCount: 2 })
    staleSaltWal.writeUInt32BE(0xdeadbeef, SQLITE_WAL_HEADER_BYTES + 8)
    const staleReader = SqliteMmapPageReader.fromBuffer(staleSaltWal)
    const report2 = staleReader.inspectWalFrames()
    expect(report2.valid).toBe(false)
    expect(report2.frames[0]?.saltMatch).toBe(false)
    expect(report2.errors.some((e) => e.includes('salt mismatch'))).toBe(true)

    // 3. Torn trailing bytes
    const validWal = buildSyntheticWalBuffer({ frameCount: 1 })
    const tornWal = Buffer.concat([validWal, Buffer.alloc(17, 0xaa)])
    const tornReader = SqliteMmapPageReader.fromBuffer(tornWal)
    const report3 = tornReader.inspectWalFrames()
    expect(report3.valid).toBe(false)
    expect(report3.trailingBytes).toBe(17)
  })

  it('enforces strict magic header validation and memory boundary protections', () => {
    // Truncated buffers
    const tinyReader = SqliteMmapPageReader.fromBuffer(Buffer.alloc(12))
    expect(tinyReader.detectFileKind()).toBe('UNKNOWN')
    expect(() => tinyReader.readDatabaseHeader()).toThrow(MmapBoundaryError)
    expect(() => tinyReader.readWalHeader()).toThrow(MmapBoundaryError)
    expect(tinyReader.inspect().valid).toBe(false)

    // Invalid DB magic
    const badDb = Buffer.alloc(4096, 0x00)
    badDb.write('NotASQLiteHeader\0', 0, 'utf8')
    const badDbReader = SqliteMmapPageReader.fromBuffer(badDb)
    expect(() => badDbReader.readDatabaseHeader()).toThrow(MmapInvalidMagicError)

    // Invalid WAL magic / version
    const badWal = Buffer.alloc(64)
    badWal.writeUInt32BE(0x12345678, 0)
    expect(() => SqliteMmapPageReader.fromBuffer(badWal).readWalHeader()).toThrow(
      MmapInvalidMagicError,
    )

    badWal.writeUInt32BE(SQLITE_WAL_MAGIC_LE, 0)
    badWal.writeUInt32BE(9999999, 4) // wrong format version
    expect(() => SqliteMmapPageReader.fromBuffer(badWal).readWalHeader()).toThrow(
      MmapInvalidMagicError,
    )

    // Boundary checks for page numbers and WAL frame index
    const validDb = Buffer.alloc(4096)
    validDb.write('SQLite format 3\0', 0, 'utf8')
    validDb.writeUInt16BE(4096, 16)
    const dbReader = SqliteMmapPageReader.fromBuffer(validDb)
    expect(() => dbReader.readPage(0)).toThrow(MmapBoundaryError)
    expect(() => dbReader.readPage(2)).toThrow(MmapBoundaryError)

    const validWal = SqliteMmapPageReader.fromBuffer(buildSyntheticWalBuffer({ frameCount: 1 }))
    expect(() => validWal.readWalFrame(-1)).toThrow(MmapBoundaryError)
    expect(() => validWal.readWalFrame(5)).toThrow(MmapBoundaryError)
  })
})
