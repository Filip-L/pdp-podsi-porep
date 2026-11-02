// Minimal Curio Market 2.0 (mk20) client: the parts of sptool's `mk20-client deal` the demo needs,
// following curio/market/mk20/client (auth.go, client.go, http_client.go) at v1.29.0.
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { keccak_256 } from '@noble/hashes/sha3'
import { hexToBytes } from 'viem'
import { ulid } from 'ulid'
import { config } from './config.ts'
import { devnet } from './pdp.ts'
import type { AggregatePlan, FileFormat } from './store.ts'

const marketPath = '/market/mk20'
const SIG_TYPE_DELEGATED = 3

// The client is the same Ethereum key Synapse pays with, as a Filecoin delegated (f410) address:
// protocol 4, Ethereum Address Manager namespace 10, then the 20-byte Ethereum address.
function client() {
  const user = devnet().info.info.users[0]
  return {
    address: user.native_addr,
    addressBytes: Uint8Array.from([4, 10, ...hexToBytes(user.evm_addr)]),
    privateKey: hexToBytes(user.private_key_hex),
  }
}

export const clientAddress = () => client().address

// "CurioAuth delegated:<address bytes>:<signature>" over sha256(address || METHOD || path || minute in RFC3339).
// Lotus verifies delegated signatures as secp256k1 over keccak256(message) with recovery id 0/1.
export function authHeader(method: string, path: string): string {
  const c = client()
  const minute = new Date()
  minute.setUTCSeconds(0, 0)
  const ts = minute.toISOString().replace('.000Z', 'Z')
  const enc = new TextEncoder()
  const digest = sha256(Uint8Array.from([...c.addressBytes, ...enc.encode(method.toUpperCase()), ...enc.encode(path), ...enc.encode(ts)]))
  const sig = secp256k1.sign(keccak_256(digest), c.privateKey)
  const sigBytes = Uint8Array.from([SIG_TYPE_DELEGATED, ...sig.toCompactRawBytes(), sig.recovery])
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
  return `CurioAuth delegated:${b64(c.addressBytes)}:${b64(sigBytes)}`
}

async function call(baseUrl: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const fullPath = marketPath + path
  const res = await fetch(baseUrl + fullPath, {
    method,
    headers: {
      Authorization: authHeader(method, fullPath),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, text }
}

export type DealChild = { pieceCidV2: string; url: string; format: FileFormat }

// Same document sptool sends for `deal --aggregate manifest.tsv`, but each child carries its real
// format (raw or car); Curio accepts Format.Raw for aggregate children as is.
export function buildDeal(provider: string, plan: AggregatePlan, children: DealChild[]) {
  return {
    identifier: ulid(),
    client: clientAddress(),
    data: {
      piece_cid: { '/': plan.aggregateCidV2 },
      format: { aggregate: { type: 1 } },
      source_aggregate: {
        pieces: children.map((c) => ({
          piece_cid: { '/': c.pieceCidV2 },
          format: c.format === 'raw' ? { raw: {} } : { car: {} },
          source_http: { urls: [{ url: c.url, headers: null, priority: 0, fallback: true }] },
        })),
      },
    },
    products: {
      ddo_v1: {
        provider,
        duration: config.dealDurationEpochs,
        start_epoch: null,
        market_address: '',
        market_deal_id: null,
      },
      retrieval_v1: { indexing: true, announce_payload: false, announce_piece: false },
    },
  }
}

export async function submitDeal(baseUrl: string, deal: ReturnType<typeof buildDeal>) {
  const r = await call(baseUrl, 'POST', '/deal', deal)
  if (r.status !== 200) throw new Error(`SP odrzucił deal (HTTP ${r.status}): ${r.text.trim()}`)
}

export type ClientDealStatus = { status?: string; errorMsg?: string; http: number; raw?: string }

export async function dealStatus(baseUrl: string, id: string): Promise<ClientDealStatus> {
  const r = await call(baseUrl, 'GET', `/status/${id}`)
  if (r.status !== 200) return { http: r.status, raw: r.text.trim() }
  const body = JSON.parse(r.text) as { ddo_v1?: { status: string; errorMsg: string } }
  return { http: 200, status: body.ddo_v1?.status, errorMsg: body.ddo_v1?.errorMsg }
}
