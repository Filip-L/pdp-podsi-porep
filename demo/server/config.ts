import { readFileSync } from 'node:fs'

export const config = {
  port: Number(process.env.PORT ?? 8080),
  devnetInfoPath: process.env.DEVNET_INFO_PATH ?? '/var/lib/contracts/devnet-info.json',
  lotusRpc: process.env.LOTUS_RPC ?? 'http://lotus:1234/rpc/v1',
  dataDir: process.env.DATA_DIR ?? '/data',
  webDir: process.env.WEB_DIR ?? 'dist',
  aggplanBin: process.env.AGGPLAN_BIN ?? 'aggplan',
  podsicheckBin: process.env.PODSICHECK_BIN ?? 'podsicheck',
  db: {
    host: process.env.DB_HOST ?? 'yugabyte',
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USER ?? 'yugabyte',
    password: process.env.DB_PASSWORD ?? 'yugabyte',
  },
  // Curio nodes whose SP-side view the demo shows. Each node has its own HarmonyDB database;
  // its miner and market URL are discovered from that database and from the chain.
  nodes: [
    { key: 'A', name: 'Węzeł A', database: 'yugabyte', container: 'porep-market-curio-devnet-curio-1' },
    { key: 'B', name: 'Węzeł B', database: 'curio_porep', container: 'porep-node-b-curio-porep-1' },
  ],
  // NV29: deals without a datacap allocation need at least 518400 epochs.
  dealDurationEpochs: 518400,
  maxFileBytes: 4_000_000,
  minFileBytes: 127,
}

// Container-network hosts as seen from the host machine (for the "verify yourself" commands).
const hostPorts: Record<string, string> = {
  'curio:12310': '127.0.0.1:22310',
  'curio-porep:12310': '127.0.0.1:22410',
  'lotus:1234': '127.0.0.1:2234',
}

export function hostUrl(url: string): string {
  return url.replace(/\/\/([^/]+)/, (m, hp: string) => (hostPorts[hp] ? `//${hostPorts[hp]}` : m))
}

export type DevnetInfo = {
  version: number
  info: {
    run_id: string
    users: { name: string; evm_addr: `0x${string}`; native_addr: string; private_key_hex: `0x${string}` }[]
    contracts: Record<string, `0x${string}`>
    pdp_sps: { provider_id: number; pdp_service_url: string; native_addr: string; eth_addr: string }[]
  }
}

export function loadDevnetInfo(): DevnetInfo {
  return JSON.parse(readFileSync(config.devnetInfoPath, 'utf8'))
}
