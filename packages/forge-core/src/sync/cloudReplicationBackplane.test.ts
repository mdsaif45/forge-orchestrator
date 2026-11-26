import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import {
  CloudReplicationBackplane,
  FilesystemObjectStorageAdapter,
  InMemoryCloudStorageAdapter,
  PacketIntegrityError,
  SignedHttpCloudStorageAdapter,
  type RemoteObjectStorageAdapter,
} from './cloudReplicationBackplane'

describe('CloudReplicationBackplane (POLISH-002)', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removeTempDir(dir)
    }
  })

  it('replicates content-addressed events and artifacts across peers with conflict-free CRDT/HLC convergence', async () => {
    const adapter = new InMemoryCloudStorageAdapter('forge-team-bucket')
    let clockA = 1_000
    let clockB = 1_005

    const peerA = new CloudReplicationBackplane({
      workspaceId: 'ws-team-1',
      nodeId: 'dev-laptop-a',
      adapter,
      hmacSecret: 'shared-team-secret',
      clock: () => clockA++,
    })

    const peerB = new CloudReplicationBackplane({
      workspaceId: 'ws-team-1',
      nodeId: 'dev-ci-b',
      adapter,
      hmacSecret: 'shared-team-secret',
      clock: () => clockB++,
    })

    peerA.appendLocalEvent('run-1', 'PLAN_LOCKED', { planId: 'p1' })
    peerA.stageLocalArtifact('art-spec', '# Specification v1\n')

    peerB.appendLocalEvent('run-1', 'TESTS_PASSED', { passed: 42 })
    peerB.stageLocalArtifact('art-junit', '<testsuite tests="42"/>')

    const pushA1 = await peerA.pushPendingPackets()
    expect(pushA1.uploadedPackets).toBe(2)
    expect(pushA1.failedPackets).toBe(0)
    expect(peerA.getPendingCount()).toBe(0)

    const pushB1 = await peerB.pushPendingPackets()
    expect(pushB1.uploadedPackets).toBe(2)

    const pullA = await peerA.pullAndReconcile()
    const pullB = await peerB.pullAndReconcile()

    // Both peers converge to the exact same HLC-ordered event sequence, artifacts, and digest
    expect(pullA.verifiedPackets).toBe(4)
    expect(pullB.verifiedPackets).toBe(4)
    expect(pullA.dashboard.stateDigest).toBe(pullB.dashboard.stateDigest)
    expect(pullA.dashboard.activePeers).toEqual(['dev-ci-b', 'dev-laptop-a'])
    expect(pullA.dashboard.totalEvents).toBe(2)
    expect(pullA.dashboard.totalArtifacts).toBe(2)
    expect(peerA.getArtifact('art-junit')?.toString('utf8')).toBe('<testsuite tests="42"/>')
    expect(peerB.getArtifact('art-spec')?.toString('utf8')).toBe('# Specification v1\n')

    // Re-pulling is completely idempotent
    const secondPull = await peerA.pullAndReconcile()
    expect(secondPull.mergedEventsCount).toBe(0)
    expect(secondPull.mergedArtifactsCount).toBe(0)
  })

  it('rejects tampered payloads or forged HMAC signatures and supports offline local-first queueing', async () => {
    const adapter = new InMemoryCloudStorageAdapter()
    const peer = new CloudReplicationBackplane({
      workspaceId: 'ws-sec',
      nodeId: 'node-sec',
      adapter,
      hmacSecret: 'secret-key-alpha',
    })

    const { packet } = peer.appendLocalEvent('run-sec', 'DEPLOY_SIGNED', { env: 'prod' })
    await peer.pushPendingPackets()

    const keys = await adapter.listObjects('workspaces/ws-sec/packets/')
    expect(keys).toHaveLength(1)
    const key = keys[0] ?? ''

    // Simulate adversarial tampering in remote object storage
    const tampered = {
      ...packet,
      payloadBase64: Buffer.from(JSON.stringify({ evil: true }), 'utf8').toString('base64'),
    }
    adapter.tamperRawObjectForTest(key, Buffer.from(JSON.stringify(tampered), 'utf8'))

    const verifierPeer = new CloudReplicationBackplane({
      workspaceId: 'ws-sec',
      nodeId: 'node-reader',
      adapter,
      hmacSecret: 'secret-key-alpha',
    })
    await expect(verifierPeer.pullAndReconcile()).rejects.toThrow(PacketIntegrityError)

    // Verify local-first offline resilience preserves pending packets cleanly when adapter errors
    let failMode = true
    const flakyAdapter: RemoteObjectStorageAdapter = {
      provider: 'S3',
      bucket: 'flaky',
      headObject: () =>
        failMode
          ? Promise.reject(new Error('Network offline'))
          : Promise.resolve({ exists: false }),
      putObject: () =>
        failMode
          ? Promise.reject(new Error('Network offline'))
          : Promise.resolve({ etag: 'ok-etag' }),
      getObject: () => Promise.resolve(null),
      listObjects: () => Promise.resolve([]),
    }

    const offlinePeer = new CloudReplicationBackplane({
      workspaceId: 'ws-offline',
      nodeId: 'laptop',
      adapter: flakyAdapter,
    })
    offlinePeer.appendLocalEvent('run-off', 'LOCAL_EDIT', { file: 'a.ts' })
    expect(offlinePeer.getLocalEvents()).toHaveLength(1)

    const offlinePush = await offlinePeer.pushPendingPackets()
    expect(offlinePush.offlineFallbackActive).toBe(true)
    expect(offlinePush.failedPackets).toBe(1)
    expect(offlinePeer.getPendingCount()).toBe(1)

    // Once connectivity restores, queued packet uploads cleanly
    failMode = false
    const retryPush = await offlinePeer.pushPendingPackets()
    expect(retryPush.offlineFallbackActive).toBe(false)
    expect(retryPush.uploadedPackets).toBe(1)
    expect(offlinePeer.getPendingCount()).toBe(0)
  })

  it('supports FilesystemObjectStorageAdapter and pluggable S3/GCS/R2 HTTP endpoints', async () => {
    const mirrorRoot = mkdtempSync(join(tmpdir(), 'forge-sync-fs-'))
    tempDirs.push(mirrorRoot)

    const fsAdapter = new FilesystemObjectStorageAdapter(mirrorRoot, 'team-bucket')
    const fsPeer = new CloudReplicationBackplane({
      workspaceId: 'ws-fs',
      nodeId: 'node-fs',
      adapter: fsAdapter,
    })
    fsPeer.stageLocalArtifact('art-fs', 'local mirror content')
    const pushFs = await fsPeer.pushPendingPackets()
    expect(pushFs.uploadedPackets).toBe(1)

    // Deduplicates on second upload attempt for same packet hash (0 re-uploads)
    const fsReader = new CloudReplicationBackplane({
      workspaceId: 'ws-fs',
      nodeId: 'node-fs-reader',
      adapter: fsAdapter,
    })
    const pullFs = await fsReader.pullAndReconcile()
    expect(pullFs.verifiedPackets).toBe(1)
    expect(fsReader.getArtifact('art-fs')?.toString('utf8')).toBe('local mirror content')

    // Verify S3, GCS, and R2 endpoint formatting & header dispatch via fetch mock
    const seenUrls: string[] = []
    const mockFetch = vi.fn((input: RequestInfo | URL) => {
      seenUrls.push(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      )
      return Promise.resolve(
        new Response(JSON.stringify({ keys: ['obj-1'] }), {
          status: 200,
          headers: { etag: 'mock-etag', 'content-length': '12' },
        }),
      )
    }) as unknown as typeof fetch

    const s3 = new SignedHttpCloudStorageAdapter({
      provider: 'S3',
      bucket: 'forge-s3',
      endpointUrl: 'https://s3.us-east-1.amazonaws.com',
      accessToken: 'tok-s3',
      fetchImpl: mockFetch,
    })
    const gcs = new SignedHttpCloudStorageAdapter({
      provider: 'GCS',
      bucket: 'forge-gcs',
      endpointUrl: 'https://storage.googleapis.com',
      accessToken: 'tok-gcs',
      fetchImpl: mockFetch,
    })
    const r2 = new SignedHttpCloudStorageAdapter({
      provider: 'R2',
      bucket: 'forge-r2',
      endpointUrl: 'https://acct.r2.cloudflarestorage.com',
      accessToken: 'tok-r2',
      fetchImpl: mockFetch,
    })

    expect(await s3.listObjects('ws/')).toEqual(['obj-1'])
    expect(await gcs.headObject('ws/p.json')).toMatchObject({ exists: true, sizeBytes: 12 })
    expect(await r2.putObject('ws/p.json', Buffer.from('hi'), { env: 'ci' })).toEqual({
      etag: 'mock-etag',
    })
    expect(seenUrls[0]).toContain('https://s3.us-east-1.amazonaws.com/forge-s3?prefix=')
    expect(seenUrls[1]).toContain('https://storage.googleapis.com/storage/v1/b/forge-gcs/o/')
    expect(seenUrls[2]).toContain('https://acct.r2.cloudflarestorage.com/forge-r2/ws/p.json')
  })
})
