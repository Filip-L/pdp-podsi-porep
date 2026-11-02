import { query } from './db.ts'
import { chainHeight, marketUrl, minerInfo, sectorInfo, sectorMessages } from './lotus.ts'
import { buildDeal, clientAddress, dealStatus, submitDeal } from './mk20.ts'
import { getNodes, nodeByMiner } from './nodes.ts'
import { lastProvenEpoch, pieceUrl } from './pdp.ts'
import { planAggregate } from './podsi.ts'
import { save, state, type DealRecord, type FileRecord } from './store.ts'

export function readyFiles(ids: string[]): FileRecord[] {
  const files = ids.map((id) => state.files.find((f) => f.id === id))
  if (files.some((f) => !f || f.status !== 'ready' || !f.pieceCid)) throw new Error('wszystkie wybrane pliki muszą być gotowe w PDP')
  if (files.length < 2) throw new Error('agregat PoDSI w Curio wymaga co najmniej 2 plików')
  return files as FileRecord[]
}

export async function planFor(ids: string[]) {
  const files = readyFiles(ids)
  const plan = await planAggregate(files.map((f) => f.pieceCid!))
  const nodes = await getNodes()
  const fits = await Promise.all(
    nodes.filter((n) => n.miner).map(async (n) => ({ miner: n.miner!, sectorSize: (await minerInfo(n.miner!)).SectorSize })),
  )
  return { plan, sectorSizes: fits }
}

export async function createDeal(ids: string[], provider: string): Promise<DealRecord> {
  const files = readyFiles(ids)
  const plan = await planAggregate(files.map((f) => f.pieceCid!))
  const { SectorSize } = await minerInfo(provider)
  if (plan.pieceSize > SectorSize) throw new Error(`agregat ${plan.pieceSize} B nie mieści się w sektorze ${SectorSize} B`)
  const node = await nodeByMiner(provider)
  const url = node?.marketUrl ?? (await marketUrl(provider))
  if (!url) throw new Error(`miner ${provider} nie ma adresu rynku on-chain`)

  // The manifest: only CIDs, the PDP SP URLs and formats. The PoRep SP fetches the bytes itself.
  const deal = buildDeal(
    provider,
    plan,
    files.map((f) => ({ pieceCidV2: f.pieceCid!, url: pieceUrl(f), format: f.format })),
  )
  const createdHeight = await chainHeight()
  await submitDeal(url, deal)
  const rec: DealRecord = {
    id: deal.identifier,
    createdAt: new Date().toISOString(),
    createdHeight,
    provider,
    nodeKey: node?.key,
    marketUrl: url,
    client: clientAddress(),
    fileIds: ids,
    plan,
  }
  state.deals.unshift(rec)
  save()
  return rec
}

type StepState = 'done' | 'active' | 'pending' | 'failed'
type Step = { key: string; label: string; state: StepState; detail?: string }

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : undefined)

// Other demo deals on the same SP whose download window overlaps this one: while they run,
// node-wide task counts cannot be attributed to a single deal.
function overlapping(deal: DealRecord): DealRecord[] {
  const start = Date.parse(deal.createdAt)
  const end = deal.aggregatedAt ? Date.parse(deal.aggregatedAt) : Date.now()
  return state.deals.filter((d) => {
    if (d.id === deal.id || d.provider !== deal.provider) return false
    const s = Date.parse(d.createdAt)
    const e = d.aggregatedAt ? Date.parse(d.aggregatedAt) : Date.now()
    return s <= end && e >= start
  })
}

export async function dealView(deal: DealRecord) {
  const node = await nodeByMiner(deal.provider)
  const client = await dealStatus(deal.marketUrl, deal.id).catch((e) => ({ http: 0, raw: (e as Error).message }) as any)

  let sp: any = null
  if (node?.available) {
    const db = node.database
    const spId = Number(deal.provider.slice(2))
    const [row] = await query(db, 'SELECT created_at FROM curio.market_mk20_deal WHERE id = $1', [deal.id])
    const since = row?.created_at ?? deal.createdAt
    const pipeline = await query(
      db,
      `SELECT aggr_index, piece_cid_v2, downloaded, after_commp, aggregated, sector, sealed, indexed, complete
       FROM curio.market_mk20_pipeline WHERE id = $1 ORDER BY aggr_index`,
      [deal.id],
    )
    if (pipeline.some((p) => p.aggregated) && !deal.aggregatedAt) deal.aggregatedAt = new Date().toISOString()
    // Curio garbage-collects finished pipeline rows; market_piece_deal keeps the sector for good.
    const [placed] = await query(db, 'SELECT sector_num FROM curio.market_piece_deal WHERE id = $1 AND sp_id = $2', [deal.id, spId])
    const sector = pipeline.map((p) => p.sector).find((s) => s !== null && s !== undefined) ?? placed?.sector_num
    if (sector !== undefined && sector !== null) deal.sector = Number(sector)
    if (placed && !deal.aggregatedAt) deal.aggregatedAt = new Date().toISOString()

    // Download window of this deal: from the SP receiving it until the aggregate was built.
    const until = deal.aggregatedAt ?? new Date().toISOString()
    const [downloads] = await query(
      db,
      `SELECT count(*) FILTER (WHERE result) AS ok, count(*) FILTER (WHERE NOT result) AS failed
       FROM curio.harmony_task_history WHERE name = 'ParkPiece' AND work_start >= $1 AND work_start <= $2`,
      [since, until],
    )
    const errors = await query(
      db,
      `SELECT name, work_end, left(replace(err, E'\\n', ' '), 240) AS err FROM curio.harmony_task_history
       WHERE work_start >= $1 AND work_start <= $2 AND NOT result AND name IN ('ParkPiece', 'CommP', 'AggregateDeals')
       ORDER BY work_end DESC LIMIT 5`,
      [since, until],
    )
    const [sdr] =
      deal.sector !== undefined
        ? await query(
            db,
            `SELECT after_sdr, after_tree_r, after_precommit_msg, after_precommit_msg_success, precommit_msg_cid,
                    after_porep, after_commit_msg, after_commit_msg_success, commit_msg_cid, failed, failed_reason, failed_reason_msg
             FROM curio.sectors_sdr_pipeline WHERE sp_id = $1 AND sector_number = $2`,
            [spId, deal.sector],
          )
        : []
    if ((pipeline.length && pipeline.every((p) => p.complete)) || (placed && !pipeline.length)) deal.complete = true
    sp = {
      node: { key: node.key, name: node.name, database: db, machines: node.machines, problem: node.problem },
      receivedAt: iso(row?.created_at),
      pipeline,
      downloads: {
        ok: Number(downloads?.ok ?? 0),
        failed: Number(downloads?.failed ?? 0),
        overlappingDeals: overlapping(deal).map((d) => d.id),
      },
      errors,
      sdr: sdr ?? null,
    }
  }

  let chain: any = null
  if (deal.sector !== undefined) {
    const info = await sectorInfo(deal.provider, deal.sector).catch(() => null)
    const ok = (m?: { exitCode: number | null }) => m?.exitCode === 0
    if (!ok(deal.chain?.preCommit) || !ok(deal.chain?.proveCommit)) {
      deal.chain = await sectorMessages(deal.provider, deal.sector, deal.createdHeight - 5).catch(() => deal.chain)
    }
    const { SectorSize } = await minerInfo(deal.provider)
    // The planned aggregate (CID and padded size) must be the piece activated in the sector.
    const pieceIsAggregate =
      ok(deal.chain?.proveCommit) &&
      (deal.chain?.proveCommit?.pieces.some((p) => p.cid === deal.plan.aggregateCidV1 && p.size === deal.plan.pieceSize) ?? false)
    chain = {
      sector: deal.sector,
      sectorSize: SectorSize,
      info: info && { sealedCid: info.SealedCID['/'], activation: info.Activation, expiration: info.Expiration },
      ...deal.chain,
      pieceIsAggregate,
    }
  }

  // PDP keeps proving the same files: a proof of the data set made after the deal was submitted.
  const dataSets = [...new Set(deal.fileIds.map((id) => state.files.find((f) => f.id === id)?.dataSetId).filter((d) => d !== undefined))]
  const pdp = await Promise.all(
    dataSets.map(async (ds) => ({ dataSetId: ds, lastProvenEpoch: await lastProvenEpoch(ds as number).catch(() => null), sinceHeight: deal.createdHeight })),
  )
  save()

  return { deal, client, sp, chain, pdp, steps: steps(deal, client, sp, chain) }
}

function steps(deal: DealRecord, client: any, sp: any, chain: any): Step[] {
  const n = deal.plan.children.length
  const rows: any[] = sp?.pipeline ?? []
  const aggregated = rows.some((r) => r.aggregated) || deal.sector !== undefined
  const downloaded = aggregated ? n : rows.filter((r) => r.downloaded).length
  const commped = aggregated ? n : rows.filter((r) => r.after_commp).length
  const sdr = sp?.sdr
  const err = (sp?.errors ?? [])[0]
  // On-chain steps count only with a successful receipt (exit code 0).
  const msgState = (m?: { exitCode: number | null }): StepState => (!m ? 'pending' : m.exitCode === 0 ? 'done' : m.exitCode === null ? 'active' : 'failed')
  const pre = msgState(chain?.preCommit)
  const commit = msgState(chain?.proveCommit)
  const active = commit === 'done' && chain?.pieceIsAggregate && chain?.info
  const finished = active && (client?.status === 'complete' || deal.complete)

  const list: Step[] = [
    {
      key: 'accepted',
      label: 'SP przyjął deal (manifest: CID + URL + format)',
      state: sp?.receivedAt || client?.status ? 'done' : 'active',
      detail: client?.status ? `status klienta mk20: ${client.status}` : undefined,
    },
    {
      key: 'download',
      label: `Pobranie plików z PDP SP (${downloaded}/${n})`,
      state: downloaded === n ? 'done' : 'active',
      detail: sp ? `zadania ParkPiece w czasie pobierania: ${sp.downloads.ok} udanych, ${sp.downloads.failed} nieudanych` : undefined,
    },
    { key: 'commp', label: `SP sprawdza CommP pobranych bajtów (${commped}/${n})`, state: commped === n ? 'done' : 'pending' },
    { key: 'aggregate', label: 'Agregat PoDSI złożony', state: aggregated ? 'done' : 'pending', detail: deal.sector !== undefined ? `sektor ${deal.sector}` : undefined },
    { key: 'seal', label: 'Sealing (SDR, drzewa)', state: sdr?.after_tree_r || pre !== 'pending' ? 'done' : 'pending' },
    {
      key: 'precommit',
      label: 'PreCommit on-chain',
      state: pre === 'active' ? 'pending' : pre,
      detail: chain?.preCommit ? `${chain.preCommit.cid}, exit code ${chain.preCommit.exitCode}` : undefined,
    },
    { key: 'porep', label: 'Dowód PoRep', state: sdr?.after_porep || commit !== 'pending' ? 'done' : 'pending' },
    {
      key: 'commit',
      label: 'ProveCommit on-chain',
      state: commit === 'active' ? 'pending' : commit,
      detail: chain?.proveCommit ? `${chain.proveCommit.cid}, exit code ${chain.proveCommit.exitCode}` : undefined,
    },
    {
      key: 'active',
      label: 'Sektor aktywny z zaplanowanym agregatem',
      state: active ? 'done' : 'pending',
      detail: chain?.info ? `aktywacja w epoce ${chain.info.activation}` : undefined,
    },
    {
      key: 'complete',
      label: 'SP zakończył deal (indeksowanie; agregat dostępny przez /piece/)',
      state: finished ? 'done' : 'pending',
      detail: client?.status ? `status klienta mk20: ${client.status}` : undefined,
    },
  ]
  // Once the sector is active, the SP-side steps before it are done even if their rows were garbage-collected.
  if (active) for (const s of list) if (s.key !== 'complete' && s.state !== 'failed') s.state = 'done'
  // The first unfinished step is the active one; a rejection or a failed sector marks it failed.
  const current = list.find((s) => s.state !== 'done')
  if (current && current.state !== 'failed') {
    current.state = 'active'
    const failed = sdr?.failed
      ? `${sdr.failed_reason}: ${sdr.failed_reason_msg}`
      : client?.status === 'failed'
        ? client.errorMsg
        : err && /mismatch|EOF|failed/i.test(err.err)
          ? `${err.name}: ${err.err}`
          : null
    if (failed) {
      current.state = 'failed'
      current.detail = failed
    }
  }
  return list
}
