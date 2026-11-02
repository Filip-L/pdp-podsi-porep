import { config } from './config.ts'
import { query } from './db.ts'
import { marketUrl } from './lotus.ts'

export type NodeView = {
  key: string
  name: string
  database: string
  container: string
  available: boolean
  miner?: string
  marketUrl?: string | null
  pdp: boolean
  machines: number
  problem?: string
}

let cache: { at: number; nodes: NodeView[] } | null = null

async function inspect(node: (typeof config.nodes)[number]): Promise<NodeView> {
  const view: NodeView = { ...node, available: false, pdp: false, machines: 0 }
  try {
    const layers = await query<{ title: string; config: string }>(node.database, 'SELECT title, config FROM curio.harmony_config')
    view.miner = layers.map((l) => l.config.match(/(?:MinerAddresses|Miners)\s*=\s*\["(t0\d+)"/)?.[1]).find(Boolean)
    view.pdp = layers.some((l) => /EnablePDP\s*=\s*true/.test(l.config))
    view.machines = Number((await query(node.database, 'SELECT count(*) AS n FROM curio.harmony_machines'))[0].n)
    if (view.miner) view.marketUrl = await marketUrl(view.miner)
    view.available = Boolean(view.miner)
    // After the host sleeps, Curio's machine row expires and the running process stops taking tasks.
    if (view.machines === 0) view.problem = `Curio nie przyjmuje zadań (brak wpisu w harmony_machines). docker restart ${node.container}`
  } catch (err) {
    view.problem = `węzeł niedostępny: ${(err as Error).message}`
  }
  return view
}

export async function getNodes(force = false): Promise<NodeView[]> {
  if (!force && cache && Date.now() - cache.at < 5000) return cache.nodes
  const nodes = await Promise.all(config.nodes.map(inspect))
  cache = { at: Date.now(), nodes }
  return nodes
}

export async function nodeByMiner(miner: string): Promise<NodeView | undefined> {
  return (await getNodes()).find((n) => n.miner === miner)
}
