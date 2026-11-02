export type NodeView = {
  key: string
  name: string
  container: string
  available: boolean
  miner?: string
  marketUrl?: string | null
  pdp: boolean
  machines: number
  problem?: string
}

export type Status = {
  runId: string
  height: number
  chain: { height: number; lagSeconds: number; lagEpochs: number; stuckForever: boolean }
  networkVersion: number
  client: { evm: string; filecoin: string }
  pdpVerifier: string
  pdpProviders: { providerId: number; url: string; ok: boolean; detail?: string }[]
  nodes: NodeView[]
  limits: { minFileBytes: number; maxFileBytes: number }
}

export type FileRecord = {
  id: string
  name: string
  size: number
  sha256: string
  format: 'raw' | 'car'
  createdAt: string
  status: 'queued' | 'uploading' | 'stored' | 'committing' | 'ready' | 'failed'
  events: { at: string; text: string }[]
  error?: string
  localPieceCid?: string
  pieceCid?: string
  providerId?: number
  dataSetId?: number
  pieceId?: number
  retrievalUrl?: string
  txHash?: string
  addedHeight?: number
}

export type FileVerification = {
  chain: {
    pdpVerifier: string
    height: number
    dataSetLive: boolean
    pieceLive: boolean
    onChainPieceCid: string
    pieceCidMatches: boolean
    nextPieceId: number
    lastProvenEpoch: number
    nextChallengeEpoch: number
  }
  piece: { url: string; httpStatus: number; bytes: number; sha256: string; matchesOriginal: boolean }
  commands: string[]
}

export type AggregatePlan = {
  aggregateCidV2: string
  aggregateCidV1: string
  pieceSize: number
  payloadSize: number
  indexOffset: number
  maxIndexEntries: number
  children: { pieceCidV2: string; pieceCidV1: string; payloadSize: number; paddedSize: number; offset: number }[]
}

export type DealRecord = {
  id: string
  createdAt: string
  createdHeight: number
  provider: string
  nodeKey?: string
  marketUrl: string
  client: string
  fileIds: string[]
  plan: AggregatePlan
  sector?: number
  complete?: boolean
  podsi?: { at: string; ok: boolean; output: string; aggregateSha256?: string; aggregateBytes?: number }
}

export type Step = { key: string; label: string; state: 'done' | 'active' | 'pending' | 'failed'; detail?: string }

export type DealView = {
  deal: DealRecord
  client: { http: number; status?: string; errorMsg?: string; raw?: string }
  sp: null | {
    node: { key: string; name: string; database: string; machines: number; problem?: string }
    receivedAt?: string
    downloads: { ok: number; failed: number; overlappingDeals: string[] }
    errors: { name: string; err: string }[]
  }
  chain: null | {
    sector: number
    sectorSize: number
    info: { sealedCid: string; activation: number; expiration: number } | null
    preCommit?: { cid: string; height: number | null; exitCode: number | null; unsealedCid: string }
    proveCommit?: { cid: string; height: number | null; exitCode: number | null; pieces: { cid: string; size: number; verifiedAllocation: unknown }[] }
    pieceIsAggregate: boolean
  }
  pdp: { dataSetId: number; lastProvenEpoch: number | null; sinceHeight: number }[]
  steps: Step[]
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  status: () => request<Status>('/api/status'),
  files: () => request<FileRecord[]>('/api/files'),
  upload: (file: File, format: string) => {
    const form = new FormData()
    form.append('file', file)
    form.append('format', format)
    return request<FileRecord>('/api/files', { method: 'POST', body: form })
  },
  verifyFile: (id: string) => request<FileVerification>(`/api/files/${id}/verify`),
  retry: (id: string) => request<FileRecord>(`/api/files/${id}/retry`, { method: 'POST' }),
  plan: (fileIds: string[]) => request<{ plan: AggregatePlan; sectorSizes: { miner: string; sectorSize: number }[] }>('/api/plan', json({ fileIds })),
  deals: () => request<DealRecord[]>('/api/deals'),
  createDeal: (fileIds: string[], provider: string) => request<DealRecord>('/api/deals', json({ fileIds, provider })),
  deal: (id: string) => request<DealView>(`/api/deals/${id}`),
  podsi: (id: string) => request<NonNullable<DealRecord['podsi']>>(`/api/deals/${id}/podsi`, { method: 'POST' }),
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(2)} MiB`
}

export const shortCid = (c?: string) => (c ? `${c.slice(0, 12)}…${c.slice(-6)}` : '—')
