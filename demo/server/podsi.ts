import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { config } from './config.ts'
import { aggregatePath, type AggregatePlan, type DealRecord } from './store.ts'

const run = promisify(execFile)

// The aggregate CID and layout follow from the children's CIDs alone (FRC-0058), so the client
// computes them before anything is sent. Same algorithm as sptool's `mk20-client aggregate`.
export async function planAggregate(childCids: string[]): Promise<AggregatePlan> {
  try {
    const { stdout } = await run(config.aggplanBin, childCids)
    return JSON.parse(stdout)
  } catch (err: any) {
    const msg = err.stdout ? JSON.parse(err.stdout).error : err.message
    throw new Error(`nie da się złożyć agregatu: ${msg}`)
  }
}

// Downloads the aggregate from the PoRep SP like any client would (/piece/<CID>) and runs the
// independent go-data-segment check: index, CommP of every segment, inclusion proofs, and the
// sector CommD rebuilt from the aggregate against the on-chain UnsealedCid.
export async function verifyPodsi(deal: DealRecord, sectorSize: number, unsealedCid: string) {
  const res = await fetch(`${deal.marketUrl}/piece/${deal.plan.aggregateCidV2}`)
  if (!res.ok) throw new Error(`SP nie zwrócił agregatu: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  await writeFile(aggregatePath(deal.id), bytes)
  const args = [aggregatePath(deal.id), String(deal.plan.pieceSize), deal.plan.aggregateCidV2, ...deal.plan.children.map((c) => c.pieceCidV2)]
  const env = { ...process.env, SECTOR_SIZE: String(sectorSize), SECTOR_COMMD: unsealedCid }
  let output: string
  let ok: boolean
  try {
    output = (await run(config.podsicheckBin, args, { env })).stdout
    ok = /equals on-chain UnsealedCid: true/.test(output)
  } catch (err: any) {
    output = `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message
    ok = false
  }
  return {
    at: new Date().toISOString(),
    ok,
    output,
    aggregateBytes: bytes.length,
    aggregateSha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
