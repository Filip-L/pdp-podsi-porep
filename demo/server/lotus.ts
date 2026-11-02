import { multiaddr } from '@multiformats/multiaddr'
import { config } from './config.ts'

type Cid = { '/': string }
let requestId = 0

export async function lotus<T>(method: string, ...params: unknown[]): Promise<T> {
  const res = await fetch(config.lotusRpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: `Filecoin.${method}`, params }),
  })
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`Lotus ${method}: ${body.error.message}`)
  return body.result as T
}

export async function chainHeight(): Promise<number> {
  return (await lotus<{ Height: number }>('ChainHead')).Height
}

export async function networkVersion(): Promise<number> {
  return lotus<number>('StateNetworkVersion', null)
}

// How far the chain head is behind the wall clock. Lotus cannot mine after more than 900 null
// rounds (chain finality), so a devnet left asleep for longer than that never recovers.
export async function chainLag() {
  const head = await lotus<{ Height: number; Blocks: { Timestamp: number }[] }>('ChainHead')
  const params = await lotus<{ BlockDelaySecs: number }>('StateGetNetworkParams')
  const lagSeconds = Math.max(0, Math.round(Date.now() / 1000) - head.Blocks[0].Timestamp)
  const lagEpochs = Math.floor(lagSeconds / params.BlockDelaySecs)
  return { height: head.Height, lagSeconds, lagEpochs, stuckForever: lagEpochs >= 900 }
}

export type MinerInfo = { SectorSize: number; Multiaddrs: string[] | null; PeerId: string | null }

export async function minerInfo(miner: string): Promise<MinerInfo> {
  return lotus<MinerInfo>('StateMinerInfo', miner, null)
}

// Same conversion as sptool: the on-chain multiaddr (/dns/<host>/tcp/<port>/ws) becomes the market URL.
export function multiaddrToUrl(b64: string): string | null {
  const parts = multiaddr(Buffer.from(b64, 'base64')).toString().split('/').filter(Boolean)
  let host = ''
  let port = ''
  let scheme = 'http'
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (['dns', 'dns4', 'dns6', 'ip4', 'ip6'].includes(p)) host = parts[++i]
    else if (p === 'tcp') port = parts[++i]
    else if (p === 'wss' || p === 'https' || p === 'tls') scheme = 'https'
  }
  return host && port ? `${scheme}://${host}:${port}` : null
}

export async function marketUrl(miner: string): Promise<string | null> {
  const info = await minerInfo(miner)
  for (const ma of info.Multiaddrs ?? []) {
    const url = multiaddrToUrl(ma)
    if (url) return url
  }
  return null
}

export type SectorInfo = { SectorNumber: number; SealedCID: Cid; Activation: number; Expiration: number }

export async function sectorInfo(miner: string, sector: number): Promise<SectorInfo | null> {
  return lotus<SectorInfo | null>('StateSectorGetInfo', miner, sector, null)
}

export type SectorMessages = {
  preCommit?: { cid: string; height: number | null; exitCode: number | null; unsealedCid: string }
  proveCommit?: {
    cid: string
    height: number | null
    exitCode: number | null
    pieces: { cid: string; size: number; verifiedAllocation: unknown }[]
  }
}

// Finds the PreCommitSectorBatch2 (28) and ProveCommitSectors3 (34) messages for one sector and
// decodes their parameters with Lotus. This is what the chain says, independent of the SP database.
export async function sectorMessages(miner: string, sector: number, fromHeight: number): Promise<SectorMessages> {
  const cids = (await lotus<Cid[] | null>('StateListMessages', { To: miner }, null, Math.max(0, fromHeight))) ?? []
  const out: SectorMessages = {}
  for (const c of cids) {
    const msg = await lotus<{ Method: number; Params: string; To: string }>('ChainGetMessage', c)
    if (msg.Method !== 28 && msg.Method !== 34) continue
    const params = await lotus<any>('StateDecodeParams', msg.To, msg.Method, msg.Params, null)
    const lookup = await lotus<{ Height: number; Receipt: { ExitCode: number } } | null>(
      'StateSearchMsg', null, c, -1, true,
    )
    const where = { cid: c['/'], height: lookup?.Height ?? null, exitCode: lookup?.Receipt.ExitCode ?? null }
    if (msg.Method === 28) {
      const s = (params.Sectors ?? []).find((x: any) => x.SectorNumber === sector)
      if (s) out.preCommit = { ...where, unsealedCid: s.UnsealedCid?.['/'] }
    } else {
      const s = (params.SectorActivations ?? []).find((x: any) => x.SectorNumber === sector)
      if (s) {
        out.proveCommit = {
          ...where,
          pieces: (s.Pieces ?? []).map((p: any) => ({
            cid: p.CID['/'],
            size: p.Size,
            verifiedAllocation: p.VerifiedAllocationKey,
          })),
        }
      }
    }
  }
  return out
}
