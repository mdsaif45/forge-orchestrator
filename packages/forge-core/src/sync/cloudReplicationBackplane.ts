import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

export type SyncPacketKind = 'EVENT_LOG_SEGMENT' | 'ARTIFACT_BLOB' | 'DASHBOARD_PROJECTION'

export type RemoteStorageProvider = 'S3' | 'GCS' | 'R2' | 'FILESYSTEM' | 'IN_MEMORY'

export interface HybridLogicalClock {
  readonly wallTimeMs: number
  readonly logicalCounter: number
  readonly nodeId: string
}

export interface ReplicatedEventRecord {
  readonly eventId: string
  readonly runId: string
  readonly eventType: string
  readonly originNodeId: string
  readonly hlc: HybridLogicalClock
  readonly payload: Readonly<Record<string, unknown>>
}

export interface ContentAddressedPacket {
  readonly packetId: string
  readonly contentHash: string
  readonly kind: SyncPacketKind
  readonly workspaceId: string
  readonly originNodeId: string
  readonly hlcTimestamp: HybridLogicalClock
  readonly vectorClock: Readonly<Record<string, number>>
  readonly parentHashes: readonly string[]
  readonly payloadBase64: string
  readonly payloadSizeBytes: number
  readonly signatureDigest: string
}

export interface HeadObjectResult {
  readonly exists: boolean
  readonly sizeBytes?: number | undefined
  readonly etag?: string | undefined
}

export interface PutObjectResult {
  readonly etag: string
}

/**
 * Pluggable remote object storage contract for S3, GCS, Cloudflare R2, or local mirrors.
 */
export interface RemoteObjectStorageAdapter {
  readonly provider: RemoteStorageProvider
  readonly bucket: string
  headObject(key: string): Promise<HeadObjectResult>
  putObject(
    key: string,
    body: Buffer,
    metadata: Readonly<Record<string, string>>,
  ): Promise<PutObjectResult>
  getObject(key: string): Promise<Buffer | null>
  listObjects(prefix: string): Promise<readonly string[]>
}

export interface TeamDashboardSnapshot {
  readonly workspaceId: string
  readonly activePeers: readonly string[]
  readonly totalEvents: number
  readonly totalArtifacts: number
  readonly mergedVectorClock: Readonly<Record<string, number>>
  readonly latestEventId: string | null
  readonly latestHlc: HybridLogicalClock | null
  readonly stateDigest: string
}

export interface ReplicationPushReport {
  readonly attemptedPackets: number
  readonly uploadedPackets: number
  readonly deduplicatedPackets: number
  readonly failedPackets: number
  readonly offlineFallbackActive: boolean
}

export interface ReplicationPullReport {
  readonly discoveredObjects: number
  readonly fetchedPackets: number
  readonly verifiedPackets: number
  readonly mergedEventsCount: number
  readonly mergedArtifactsCount: number
  readonly dashboard: TeamDashboardSnapshot
}

export interface SignedHttpStorageOptions {
  readonly provider: 'S3' | 'GCS' | 'R2'
  readonly bucket: string
  readonly endpointUrl: string
  readonly accessToken: string
  readonly fetchImpl?: typeof fetch | undefined
}

export interface BackplaneOptions {
  readonly workspaceId: string
  readonly nodeId: string
  readonly adapter: RemoteObjectStorageAdapter
  readonly hmacSecret?: string | undefined
  readonly clock?: (() => number) | undefined
}

export class PacketIntegrityError extends Error {
  readonly packetId: string
  readonly contentHash: string

  constructor(packetId: string, contentHash: string, reason: string) {
    super(`Replication packet "${packetId}" (${contentHash}) failed integrity check: ${reason}`)
    this.name = 'PacketIntegrityError'
    this.packetId = packetId
    this.contentHash = contentHash
  }
}

export class CloudReplicationError extends Error {
  constructor(message: string) {
    super(`Cloud replication error: ${message}`)
    this.name = 'CloudReplicationError'
  }
}

export function compareHlc(a: HybridLogicalClock, b: HybridLogicalClock): number {
  if (a.wallTimeMs !== b.wallTimeMs) {
    return a.wallTimeMs - b.wallTimeMs
  }
  if (a.logicalCounter !== b.logicalCounter) {
    return a.logicalCounter - b.logicalCounter
  }
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
}

export function computePacketContentHash(
  kind: SyncPacketKind,
  workspaceId: string,
  originNodeId: string,
  hlcTimestamp: HybridLogicalClock,
  parentHashes: readonly string[],
  payloadBytes: Buffer,
): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        kind,
        workspaceId,
        originNodeId,
        hlcTimestamp,
        parentHashes: [...parentHashes].sort(),
      }),
    )
    .update('|')
    .update(payloadBytes)
    .digest('hex')
  return `sha256:${hash}`
}

export function computePacketSignature(
  contentHash: string,
  vectorClock: Readonly<Record<string, number>>,
  hmacSecret?: string,
): string {
  const canonicalClockEntries = Object.entries(vectorClock).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  const message = `${contentHash}:${JSON.stringify(canonicalClockEntries)}`
  if (hmacSecret !== undefined && hmacSecret.length > 0) {
    return createHmac('sha256', hmacSecret).update(message).digest('hex')
  }
  return createHash('sha256').update(message).digest('hex')
}

export function verifyPacketIntegrity(packet: ContentAddressedPacket, hmacSecret?: string): Buffer {
  const payloadBytes = Buffer.from(packet.payloadBase64, 'base64')
  const expectedHash = computePacketContentHash(
    packet.kind,
    packet.workspaceId,
    packet.originNodeId,
    packet.hlcTimestamp,
    packet.parentHashes,
    payloadBytes,
  )

  if (expectedHash !== packet.contentHash) {
    throw new PacketIntegrityError(
      packet.packetId,
      packet.contentHash,
      `Content hash mismatch (expected ${expectedHash})`,
    )
  }

  if (payloadBytes.byteLength !== packet.payloadSizeBytes) {
    throw new PacketIntegrityError(
      packet.packetId,
      packet.contentHash,
      `Payload byte length mismatch (expected ${String(payloadBytes.byteLength)}, got ${String(packet.payloadSizeBytes)})`,
    )
  }

  const expectedSignature = computePacketSignature(
    packet.contentHash,
    packet.vectorClock,
    hmacSecret,
  )
  if (expectedSignature !== packet.signatureDigest) {
    throw new PacketIntegrityError(
      packet.packetId,
      packet.contentHash,
      'Cryptographic signature digest mismatch',
    )
  }

  return payloadBytes
}

/**
 * Merges replicated event logs conflict-free via deterministic HLC total order & content deduplication.
 */
export function mergeReplicationEvents(
  localEvents: readonly ReplicatedEventRecord[],
  incomingEvents: readonly ReplicatedEventRecord[],
): ReplicatedEventRecord[] {
  const byId = new Map<string, ReplicatedEventRecord>()
  for (const evt of localEvents) {
    byId.set(evt.eventId, evt)
  }
  for (const evt of incomingEvents) {
    if (!byId.has(evt.eventId)) {
      byId.set(evt.eventId, evt)
    }
  }
  return Array.from(byId.values()).sort((a, b) => {
    const cmp = compareHlc(a.hlc, b.hlc)
    if (cmp !== 0) {
      return cmp
    }
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
  })
}

/**
 * Pluggable S3 / GCS / Cloudflare R2 REST storage adapter using standard object endpoints and Bearer/Sig auth.
 */
export class SignedHttpCloudStorageAdapter implements RemoteObjectStorageAdapter {
  public readonly provider: 'S3' | 'GCS' | 'R2'
  public readonly bucket: string
  private readonly endpointUrl: string
  private readonly accessToken: string
  private readonly fetchImpl: typeof fetch

  constructor(options: SignedHttpStorageOptions) {
    this.provider = options.provider
    this.bucket = options.bucket.trim()
    this.endpointUrl = options.endpointUrl.replace(/\/+$/, '')
    this.accessToken = options.accessToken
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  public buildObjectUrl(key: string): string {
    const cleanKey = key.replace(/^\/+/, '')
    if (this.provider === 'GCS') {
      return `${this.endpointUrl}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(cleanKey)}`
    }
    return `${this.endpointUrl}/${encodeURIComponent(this.bucket)}/${cleanKey}`
  }

  private buildHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'x-forge-storage-provider': this.provider,
      ...extra,
    }
  }

  public async headObject(key: string): Promise<HeadObjectResult> {
    const res = await this.fetchImpl(this.buildObjectUrl(key), {
      method: 'HEAD',
      headers: this.buildHeaders(),
    })
    if (res.status === 404) {
      return { exists: false }
    }
    if (!res.ok) {
      throw new CloudReplicationError(
        `${this.provider} HEAD failed (${String(res.status)}) for "${key}"`,
      )
    }
    const lenHeader = res.headers.get('content-length')
    const etag = res.headers.get('etag') ?? undefined
    return {
      exists: true,
      ...(lenHeader !== null ? { sizeBytes: Number(lenHeader) } : {}),
      ...(etag !== undefined ? { etag } : {}),
    }
  }

  public async putObject(
    key: string,
    body: Buffer,
    metadata: Readonly<Record<string, string>>,
  ): Promise<PutObjectResult> {
    const metaHeaders: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    }
    for (const [k, v] of Object.entries(metadata)) {
      metaHeaders[`x-forge-meta-${k.toLowerCase()}`] = v
    }

    const res = await this.fetchImpl(this.buildObjectUrl(key), {
      method: 'PUT',
      headers: this.buildHeaders(metaHeaders),
      body: new Uint8Array(body),
    })
    if (!res.ok) {
      throw new CloudReplicationError(
        `${this.provider} PUT failed (${String(res.status)}) for "${key}"`,
      )
    }
    const etag = res.headers.get('etag') ?? createHash('sha256').update(body).digest('hex')
    return { etag }
  }

  public async getObject(key: string): Promise<Buffer | null> {
    const res = await this.fetchImpl(this.buildObjectUrl(key), {
      method: 'GET',
      headers: this.buildHeaders(),
    })
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      throw new CloudReplicationError(
        `${this.provider} GET failed (${String(res.status)}) for "${key}"`,
      )
    }
    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  }

  public async listObjects(prefix: string): Promise<readonly string[]> {
    const cleanPrefix = prefix.replace(/^\/+/, '')
    const listUrl =
      this.provider === 'GCS'
        ? `${this.endpointUrl}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?prefix=${encodeURIComponent(cleanPrefix)}`
        : `${this.endpointUrl}/${encodeURIComponent(this.bucket)}?prefix=${encodeURIComponent(cleanPrefix)}`

    const res = await this.fetchImpl(listUrl, {
      method: 'GET',
      headers: this.buildHeaders(),
    })
    if (!res.ok) {
      throw new CloudReplicationError(
        `${this.provider} LIST failed (${String(res.status)}) for prefix "${cleanPrefix}"`,
      )
    }
    const parsed = (await res.json()) as { readonly keys?: readonly string[] }
    return parsed.keys ?? []
  }
}

/**
 * In-memory remote object store backing multi-peer tests without external network calls.
 */
export class InMemoryCloudStorageAdapter implements RemoteObjectStorageAdapter {
  public readonly provider: RemoteStorageProvider = 'IN_MEMORY'
  public readonly bucket: string
  private readonly objects = new Map<string, { readonly body: Buffer; readonly etag: string }>()

  constructor(bucket = 'forge-team-sync') {
    this.bucket = bucket
  }

  public headObject(key: string): Promise<HeadObjectResult> {
    const hit = this.objects.get(key)
    return Promise.resolve(
      hit ? { exists: true, sizeBytes: hit.body.byteLength, etag: hit.etag } : { exists: false },
    )
  }

  public putObject(key: string, body: Buffer): Promise<PutObjectResult> {
    const etag = createHash('sha256').update(body).digest('hex')
    this.objects.set(key, { body: Buffer.from(body), etag })
    return Promise.resolve({ etag })
  }

  public getObject(key: string): Promise<Buffer | null> {
    const hit = this.objects.get(key)
    return Promise.resolve(hit ? Buffer.from(hit.body) : null)
  }

  public listObjects(prefix: string): Promise<readonly string[]> {
    return Promise.resolve(
      Array.from(this.objects.keys())
        .filter((k) => k.startsWith(prefix))
        .sort(),
    )
  }

  /** Test helper allowing adversarial payload tampering simulation. */
  public tamperRawObjectForTest(key: string, rawBody: Buffer): void {
    const existing = this.objects.get(key)
    this.objects.set(key, {
      body: Buffer.from(rawBody),
      etag: existing?.etag ?? 'tampered',
    })
  }
}

/**
 * Local filesystem object mirror adapter preserving air-gapped or NAS team sync.
 */
export class FilesystemObjectStorageAdapter implements RemoteObjectStorageAdapter {
  public readonly provider: RemoteStorageProvider = 'FILESYSTEM'
  public readonly bucket: string
  private readonly rootDir: string

  constructor(rootDir: string, bucket = 'local-mirror') {
    this.rootDir = resolve(rootDir)
    this.bucket = bucket
  }

  private resolveKeyPath(key: string): string {
    const normalized = key.replace(/^\/+/, '').replace(/\.\./g, '')
    return join(this.rootDir, this.bucket, normalized)
  }

  public async headObject(key: string): Promise<HeadObjectResult> {
    const fullPath = this.resolveKeyPath(key)
    try {
      const info = await stat(fullPath)
      return { exists: true, sizeBytes: info.size }
    } catch {
      return { exists: false }
    }
  }

  public async putObject(key: string, body: Buffer): Promise<PutObjectResult> {
    const fullPath = this.resolveKeyPath(key)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, body)
    return { etag: createHash('sha256').update(body).digest('hex') }
  }

  public async getObject(key: string): Promise<Buffer | null> {
    const fullPath = this.resolveKeyPath(key)
    try {
      return await readFile(fullPath)
    } catch {
      return null
    }
  }

  public async listObjects(prefix: string): Promise<readonly string[]> {
    const bucketRoot = join(this.rootDir, this.bucket)
    const collected: string[] = []

    const walk = async (dir: string): Promise<void> => {
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        return
      }
      for (const name of entries) {
        const abs = join(dir, name)
        const s = await stat(abs)
        if (s.isDirectory()) {
          await walk(abs)
        } else {
          const relKey = relative(bucketRoot, abs).split('\\').join('/')
          if (relKey.startsWith(prefix.replace(/^\/+/, ''))) {
            collected.push(relKey)
          }
        }
      }
    }

    await walk(bucketRoot)
    return collected.sort()
  }
}

/**
 * Cloud State Replication and Team Collaboration Backplane (POLISH-002).
 * Maintains local-first sovereignty by committing all events and artifacts locally first,
 * packaging signed content-addressed sync packets, and performing HLC/vector-clock conflict-free merges.
 */
export class CloudReplicationBackplane {
  private readonly workspaceId: string
  private readonly nodeId: string
  private readonly adapter: RemoteObjectStorageAdapter
  private readonly hmacSecret?: string | undefined
  private readonly clock: () => number

  private lastWallMs = 0
  private logicalCounter = 0
  private readonly vectorClock: Record<string, number> = {}
  private readonly localEvents: ReplicatedEventRecord[] = []
  private readonly localArtifacts = new Map<string, Buffer>()
  private readonly packetStore = new Map<string, ContentAddressedPacket>()
  private readonly pendingPacketHashes: string[] = []
  private readonly processedPacketHashes = new Set<string>()
  private readonly peers = new Set<string>()

  constructor(options: BackplaneOptions) {
    this.workspaceId = options.workspaceId.trim()
    this.nodeId = options.nodeId.trim()
    this.adapter = options.adapter
    this.hmacSecret = options.hmacSecret
    this.clock = options.clock ?? Date.now
    this.vectorClock[this.nodeId] = 0
    this.peers.add(this.nodeId)
  }

  private nextHlc(): HybridLogicalClock {
    const physical = this.clock()
    if (physical > this.lastWallMs) {
      this.lastWallMs = physical
      this.logicalCounter = 0
    } else {
      this.logicalCounter++
    }
    this.vectorClock[this.nodeId] = (this.vectorClock[this.nodeId] ?? 0) + 1
    return {
      wallTimeMs: this.lastWallMs,
      logicalCounter: this.logicalCounter,
      nodeId: this.nodeId,
    }
  }

  private packetStorageKey(contentHash: string): string {
    const safeHash = contentHash.replace(':', '-')
    return `workspaces/${this.workspaceId}/packets/${safeHash}.json`
  }

  private createSignedPacket(
    kind: SyncPacketKind,
    payloadBytes: Buffer,
    hlc: HybridLogicalClock,
  ): ContentAddressedPacket {
    const parentHashes = Array.from(this.processedPacketHashes).slice(-2)
    const contentHash = computePacketContentHash(
      kind,
      this.workspaceId,
      this.nodeId,
      hlc,
      parentHashes,
      payloadBytes,
    )
    const clockSnapshot = { ...this.vectorClock }
    const signatureDigest = computePacketSignature(contentHash, clockSnapshot, this.hmacSecret)

    const packet: ContentAddressedPacket = {
      packetId: randomUUID(),
      contentHash,
      kind,
      workspaceId: this.workspaceId,
      originNodeId: this.nodeId,
      hlcTimestamp: hlc,
      vectorClock: clockSnapshot,
      parentHashes,
      payloadBase64: payloadBytes.toString('base64'),
      payloadSizeBytes: payloadBytes.byteLength,
      signatureDigest,
    }

    this.packetStore.set(contentHash, packet)
    this.processedPacketHashes.add(contentHash)
    this.pendingPacketHashes.push(contentHash)
    return packet
  }

  /**
   * Commits a local event immediately (local-first sovereignty) and queues a signed sync packet.
   */
  public appendLocalEvent(
    runId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): { readonly event: ReplicatedEventRecord; readonly packet: ContentAddressedPacket } {
    const hlc = this.nextHlc()
    const event: ReplicatedEventRecord = {
      eventId: `${this.nodeId}:${String(hlc.wallTimeMs)}:${String(hlc.logicalCounter)}:${randomUUID().slice(0, 8)}`,
      runId,
      eventType,
      originNodeId: this.nodeId,
      hlc,
      payload,
    }
    this.localEvents.push(event)
    const bytes = Buffer.from(JSON.stringify({ events: [event] }), 'utf8')
    const packet = this.createSignedPacket('EVENT_LOG_SEGMENT', bytes, hlc)
    return { event, packet }
  }

  /**
   * Commits an immutable artifact blob locally and queues a content-addressed sync packet.
   */
  public stageLocalArtifact(artifactId: string, content: Buffer | string): ContentAddressedPacket {
    const hlc = this.nextHlc()
    const rawBuffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    this.localArtifacts.set(artifactId, rawBuffer)
    const bytes = Buffer.from(
      JSON.stringify({ artifactId, contentBase64: rawBuffer.toString('base64') }),
      'utf8',
    )
    return this.createSignedPacket('ARTIFACT_BLOB', bytes, hlc)
  }

  /**
   * Pushes pending local content-addressed packets idempotently to the configured remote storage adapter.
   * Tolerates transient offline failures without losing local-first queued state.
   */
  public async pushPendingPackets(): Promise<ReplicationPushReport> {
    let attempted = 0
    let uploaded = 0
    let deduplicated = 0
    let failed = 0
    const remaining: string[] = []

    while (this.pendingPacketHashes.length > 0) {
      const hash = this.pendingPacketHashes.shift()
      if (!hash) {
        continue
      }
      const packet = this.packetStore.get(hash)
      if (!packet) {
        continue
      }
      attempted++
      const key = this.packetStorageKey(hash)
      try {
        const head = await this.adapter.headObject(key)
        if (head.exists) {
          deduplicated++
          continue
        }
        await this.adapter.putObject(key, Buffer.from(JSON.stringify(packet), 'utf8'), {
          workspaceId: this.workspaceId,
          kind: packet.kind,
          originNodeId: packet.originNodeId,
        })
        uploaded++
      } catch {
        failed++
        remaining.push(hash)
      }
    }

    this.pendingPacketHashes.push(...remaining)
    return {
      attemptedPackets: attempted,
      uploadedPackets: uploaded,
      deduplicatedPackets: deduplicated,
      failedPackets: failed,
      offlineFallbackActive: failed > 0,
    }
  }

  /**
   * Pulls missing remote packets, cryptographically verifies hashes + signatures, and merges state conflict-free.
   */
  public async pullAndReconcile(): Promise<ReplicationPullReport> {
    const prefix = `workspaces/${this.workspaceId}/packets/`
    const keys = await this.adapter.listObjects(prefix)
    let fetchedPackets = 0
    let verifiedPackets = 0
    let mergedEventsCount = 0
    let mergedArtifactsCount = 0
    const incomingEvents: ReplicatedEventRecord[] = []

    for (const key of keys) {
      const raw = await this.adapter.getObject(key)
      if (!raw) {
        continue
      }
      fetchedPackets++
      const packet = JSON.parse(raw.toString('utf8')) as ContentAddressedPacket
      const payloadBytes = verifyPacketIntegrity(packet, this.hmacSecret)
      verifiedPackets++

      this.peers.add(packet.originNodeId)
      for (const [peer, count] of Object.entries(packet.vectorClock)) {
        this.vectorClock[peer] = Math.max(this.vectorClock[peer] ?? 0, count)
      }
      if (packet.hlcTimestamp.wallTimeMs > this.lastWallMs) {
        this.lastWallMs = packet.hlcTimestamp.wallTimeMs
        this.logicalCounter = packet.hlcTimestamp.logicalCounter
      }

      if (this.processedPacketHashes.has(packet.contentHash)) {
        continue
      }
      this.processedPacketHashes.add(packet.contentHash)
      this.packetStore.set(packet.contentHash, packet)

      const decoded = JSON.parse(payloadBytes.toString('utf8')) as {
        readonly events?: readonly ReplicatedEventRecord[]
        readonly artifactId?: string
        readonly contentBase64?: string
      }

      if (packet.kind === 'EVENT_LOG_SEGMENT' && decoded.events) {
        incomingEvents.push(...decoded.events)
        mergedEventsCount += decoded.events.length
      } else if (
        packet.kind === 'ARTIFACT_BLOB' &&
        decoded.artifactId !== undefined &&
        decoded.contentBase64 !== undefined
      ) {
        if (!this.localArtifacts.has(decoded.artifactId)) {
          this.localArtifacts.set(decoded.artifactId, Buffer.from(decoded.contentBase64, 'base64'))
          mergedArtifactsCount++
        }
      }
    }

    if (incomingEvents.length > 0) {
      const merged = mergeReplicationEvents(this.localEvents, incomingEvents)
      this.localEvents.length = 0
      this.localEvents.push(...merged)
    }

    return {
      discoveredObjects: keys.length,
      fetchedPackets,
      verifiedPackets,
      mergedEventsCount,
      mergedArtifactsCount,
      dashboard: this.getTeamDashboardState(),
    }
  }

  public getLocalEvents(): readonly ReplicatedEventRecord[] {
    return this.localEvents
  }

  public getArtifact(artifactId: string): Buffer | null {
    return this.localArtifacts.get(artifactId) ?? null
  }

  public getPendingCount(): number {
    return this.pendingPacketHashes.length
  }

  /**
   * Produces a consistent team coordination dashboard snapshot over converged replicated state.
   */
  public getTeamDashboardState(): TeamDashboardSnapshot {
    const activePeers = Array.from(this.peers).sort()
    const latestEvent = this.localEvents[this.localEvents.length - 1] ?? null
    const mergedVectorClock: Record<string, number> = {}
    for (const k of Object.keys(this.vectorClock).sort()) {
      const val = this.vectorClock[k]
      if (val !== undefined) {
        mergedVectorClock[k] = val
      }
    }

    const stateDigest = createHash('sha256')
      .update(
        JSON.stringify({
          workspaceId: this.workspaceId,
          activePeers,
          eventIds: this.localEvents.map((e) => e.eventId),
          artifactIds: Array.from(this.localArtifacts.keys()).sort(),
          mergedVectorClock,
        }),
      )
      .digest('hex')

    return {
      workspaceId: this.workspaceId,
      activePeers,
      totalEvents: this.localEvents.length,
      totalArtifacts: this.localArtifacts.size,
      mergedVectorClock,
      latestEventId: latestEvent?.eventId ?? null,
      latestHlc: latestEvent?.hlc ?? null,
      stateDigest,
    }
  }
}
