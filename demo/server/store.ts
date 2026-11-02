import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'
import type { SectorMessages } from './lotus.ts'

export type FileFormat = 'raw' | 'car'

export type FileRecord = {
  id: string
  name: string
  size: number
  sha256: string
  format: FileFormat
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
  // Chain height right after the piece was confirmed in the data set.
  addedHeight?: number
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
  // Last SP-side state seen (Curio may garbage-collect pipeline rows after completion).
  sector?: number
  complete?: boolean
  // When the demo first saw the aggregate built: closes the window for counting downloads.
  aggregatedAt?: string
  chain?: SectorMessages
  podsi?: { at: string; ok: boolean; output: string; aggregateSha256?: string; aggregateBytes?: number }
}

type State = { runId?: string; files: FileRecord[]; deals: DealRecord[] }

const file = () => join(config.dataDir, 'state.json')

function load(): State {
  mkdirSync(join(config.dataDir, 'files'), { recursive: true })
  mkdirSync(join(config.dataDir, 'aggregates'), { recursive: true })
  let s: State
  try {
    s = JSON.parse(readFileSync(file(), 'utf8'))
  } catch {
    return { files: [], deals: [] }
  }
  // The upload queue lives in memory: uploads cut off by a restart are marked failed, so they can be retried.
  for (const f of s.files) {
    if (f.status !== 'ready' && f.status !== 'failed') {
      f.status = 'failed'
      f.error = 'upload przerwany restartem demo'
      f.events.push({ at: new Date().toISOString(), text: `Błąd: ${f.error}` })
    }
  }
  return s
}

export const state: State = load()

export function save() {
  writeFileSync(file() + '.tmp', JSON.stringify(state, null, 2))
  renameSync(file() + '.tmp', file())
}

// Files and deals belong to one devnet run. After `just reset` (new run id) they are archived,
// because their data sets, deals and sectors no longer exist.
export function syncRun(runId: string) {
  if (state.runId === runId) return
  if (state.runId && (state.files.length || state.deals.length)) {
    writeFileSync(join(config.dataDir, `state-${state.runId}.json`), JSON.stringify(state, null, 2))
  }
  state.runId = runId
  state.files = []
  state.deals = []
  save()
}

export const filePath = (id: string) => join(config.dataDir, 'files', id)
export const aggregatePath = (dealId: string) => join(config.dataDir, 'aggregates', `${dealId}.bin`)

export function event(rec: FileRecord, text: string) {
  rec.events.push({ at: new Date().toISOString(), text })
  save()
}
