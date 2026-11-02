import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Synapse } from '@filoz/synapse-sdk'
import { toChain, validateDevnetInfo } from '@filoz/synapse-core/devnet'
import * as Piece from '@filoz/synapse-core/piece'
import { CID } from 'multiformats/cid'
import { createPublicClient, createWalletClient, hexToBytes, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hostUrl, loadDevnetInfo } from './config.ts'
import { event, filePath, save, type FileRecord } from './store.ts'

const pdpVerifierAbi = parseAbi([
  'function dataSetLive(uint256 setId) view returns (bool)',
  'function pieceLive(uint256 setId, uint256 pieceId) view returns (bool)',
  'function getPieceCid(uint256 setId, uint256 pieceId) view returns ((bytes data))',
  'function getNextPieceId(uint256 setId) view returns (uint256)',
  'function getDataSetLastProvenEpoch(uint256 setId) view returns (uint256)',
  'function getNextChallengeEpoch(uint256 setId) view returns (uint256)',
])

let cached: { runId: string; synapse: Synapse; chain: ReturnType<typeof toChain>; info: ReturnType<typeof loadDevnetInfo> } | null = null

// Rebuilt when the devnet is reset (new run id, new contracts).
export function devnet() {
  const raw = loadDevnetInfo()
  if (!cached || cached.runId !== raw.info.run_id) {
    const chain = toChain(validateDevnetInfo(raw))
    const user = raw.info.users[0]
    const synapse = Synapse.create({
      chain,
      transport: http(),
      account: privateKeyToAccount(user.private_key_hex),
      source: 'pdp-podsi-porep-demo',
    })
    cached = { runId: raw.info.run_id, synapse, chain, info: raw }
  }
  return cached
}

export const pdpVerifierAddress = () => devnet().info.info.contracts.pdp_verifier_proxy_addr

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

const topUpAbi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function deposit(address token, address to, uint256 amount)',
])
const minTopUp = 10n * 10n ** 18n

// Synapse tops up the Filecoin Pay deposit with an ERC-2612 permit, but the devnet's mock USDFC
// has no nonces() and reverts. A plain approve + deposit works with any ERC-20. Deposits at least
// 10 USDFC so a demo session does not need a top-up for every file.
async function depositWithApprove(needed: bigint): Promise<string> {
  const { chain, info } = devnet()
  const user = info.info.users[0]
  const token = info.info.contracts.mockusdfc_addr
  const pay = info.info.contracts.filecoin_pay_v1_addr
  const amount = needed > minTopUp ? needed : minTopUp
  const wallet = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(user.private_key_hex) })
  const client = createPublicClient({ chain, transport: http() })
  const approve = await wallet.writeContract({ address: token, abi: topUpAbi, functionName: 'approve', args: [pay, amount] })
  await client.waitForTransactionReceipt({ hash: approve })
  const deposit = await wallet.writeContract({ address: pay, abi: topUpAbi, functionName: 'deposit', args: [token, user.evm_addr, amount] })
  const receipt = await client.waitForTransactionReceipt({ hash: deposit })
  if (receipt.status !== 'success') throw new Error(`depozyt nie przeszedł (tx ${deposit})`)
  return deposit
}

// Uploads run one at a time: they share one wallet, so parallel transactions would race on nonces.
let queue: Promise<void> = Promise.resolve()

export function enqueueUpload(rec: FileRecord) {
  queue = queue.then(() => upload(rec)).catch(() => {})
}

async function upload(rec: FileRecord) {
  const { synapse } = devnet()
  try {
    rec.status = 'uploading'
    const bytes = new Uint8Array(await readFile(filePath(rec.id)))
    rec.localPieceCid = (await Piece.calculate(bytes)).toString()
    event(rec, `Klient policzył lokalnie PieceCID: ${rec.localPieceCid}`)

    // One context with one copy, shared by prepare (deposit sizing) and upload; prepare alone
    // would size the deposit for Synapse's default of two copies.
    const contexts = await synapse.storage.createContexts({ copies: 1 })
    event(rec, `Wybrany SP PDP: provider ${contexts[0].provider.id} (${contexts[0].provider.serviceProvider})`)
    const { transaction } = await synapse.storage.prepare({ context: contexts, pieceSizes: [BigInt(bytes.length)] })
    if (transaction && !transaction.includesApproval) {
      const hash = await depositWithApprove(transaction.depositAmount)
      event(rec, `Filecoin Pay: dopłata depozytu przez approve + deposit (tx ${hash})`)
    } else if (transaction) {
      const { hash } = await transaction.execute()
      event(rec, `Filecoin Pay: depozyt i zgoda dla FWSS (tx ${hash})`)
    }

    const result = await synapse.storage.upload(bytes, {
      contexts,
      callbacks: {
        onStored: (providerId, pieceCid) => {
          rec.status = 'stored'
          event(rec, `SP ${providerId} przyjął bajty i potwierdził PieceCID ${pieceCid}`)
        },
        onPiecesAdded: (tx, providerId) => {
          rec.status = 'committing'
          rec.txHash = tx
          event(rec, `Transakcja dodania kawałka do data setu (SP ${providerId}): ${tx}`)
        },
        onPiecesConfirmed: (dataSetId, providerId, pieces) => {
          const p = pieces[0]
          event(rec, `On-chain: data set ${dataSetId}, pieceId ${p?.pieceId} (SP ${providerId})`)
        },
      },
    })
    const copy = result.copies[0]
    if (!copy) throw new Error(result.failedAttempts.map((a) => a.error).join('; ') || 'brak kopii')
    rec.pieceCid = result.pieceCid.toString()
    rec.providerId = Number(copy.providerId)
    rec.dataSetId = Number(copy.dataSetId)
    rec.pieceId = Number(copy.pieceId)
    rec.retrievalUrl = copy.retrievalUrl
    rec.addedHeight = Number(await createPublicClient({ chain: devnet().chain, transport: http() }).getBlockNumber())
    rec.status = 'ready'
    event(rec, `Gotowe: plik jest w PDP (data set ${rec.dataSetId}, pieceId ${rec.pieceId})`)
  } catch (err) {
    rec.status = 'failed'
    rec.error = (err as Error).message
    event(rec, `Błąd: ${rec.error}`)
  }
  save()
}

// Curio answers /pdp/ping with 503 while its chain view lags or after repeated task failures;
// Synapse then refuses to upload ("failed health check").
export async function pdpHealth() {
  return Promise.all(
    devnet().info.info.pdp_sps.map(async (sp) => {
      try {
        const res = await fetch(`${sp.pdp_service_url}/pdp/ping`, { signal: AbortSignal.timeout(5000) })
        return { providerId: sp.provider_id, url: sp.pdp_service_url, ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` }
      } catch (err) {
        return { providerId: sp.provider_id, url: sp.pdp_service_url, ok: false, detail: (err as Error).message }
      }
    }),
  )
}

export function pieceUrl(rec: FileRecord): string {
  if (rec.retrievalUrl) return rec.retrievalUrl
  const sp = devnet().info.info.pdp_sps.find((s) => s.provider_id === rec.providerId)
  return `${sp?.pdp_service_url ?? 'http://curio:12310'}/piece/${rec.pieceCid}`
}

// What the client can check on its own: the bytes served by the PDP SP and the PDPVerifier state.
export async function verifyFile(rec: FileRecord) {
  if (rec.dataSetId === undefined || rec.pieceId === undefined || !rec.pieceCid) throw new Error('plik nie jest jeszcze w PDP')
  const { chain } = devnet()
  const client = createPublicClient({ chain, transport: http() })
  const address = pdpVerifierAddress()
  const ds = BigInt(rec.dataSetId)
  const pid = BigInt(rec.pieceId)
  const read = <T>(functionName: any, args: readonly [bigint] | readonly [bigint, bigint]) =>
    client.readContract({ address, abi: pdpVerifierAbi, functionName, args }) as Promise<T>

  const [dataSetLive, pieceLive, cidOnChain, nextPieceId, lastProven, nextChallenge, height] = await Promise.all([
    read<boolean>('dataSetLive', [ds] as const),
    read<boolean>('pieceLive', [ds, pid]),
    read<{ data: `0x${string}` }>('getPieceCid', [ds, pid]),
    read<bigint>('getNextPieceId', [ds]),
    read<bigint>('getDataSetLastProvenEpoch', [ds]),
    read<bigint>('getNextChallengeEpoch', [ds]),
    client.getBlockNumber(),
  ])
  const onChainPieceCid = CID.decode(hexToBytes(cidOnChain.data)).toString()

  const url = pieceUrl(rec)
  const res = await fetch(url)
  const served = new Uint8Array(await res.arrayBuffer())
  const servedSha = sha256(served)

  const castCall = (sig: string, args: string) =>
    `docker exec porep-market-curio-devnet-curio-1 cast call --rpc-url http://lotus:1234/rpc/v1 ${address} '${sig}' ${args}`
  return {
    chain: {
      pdpVerifier: address,
      height: Number(height),
      dataSetLive,
      pieceLive,
      onChainPieceCid,
      pieceCidMatches: onChainPieceCid === rec.pieceCid,
      nextPieceId: Number(nextPieceId),
      lastProvenEpoch: Number(lastProven),
      nextChallengeEpoch: Number(nextChallenge),
    },
    piece: {
      url,
      httpStatus: res.status,
      bytes: served.length,
      sha256: servedSha,
      matchesOriginal: res.ok && servedSha === rec.sha256,
    },
    commands: [
      castCall('getPieceCid(uint256,uint256)((bytes))', `${ds} ${pid}`),
      castCall('pieceLive(uint256,uint256)(bool)', `${ds} ${pid}`),
      castCall('getDataSetLastProvenEpoch(uint256)(uint256)', `${ds}`),
      `curl -s ${hostUrl(url)} | shasum -a 256   # = ${rec.sha256}`,
    ],
  }
}

export async function lastProvenEpoch(dataSetId: number): Promise<number> {
  const { chain } = devnet()
  const client = createPublicClient({ chain, transport: http() })
  return Number(
    await client.readContract({
      address: pdpVerifierAddress(),
      abi: pdpVerifierAbi,
      functionName: 'getDataSetLastProvenEpoch',
      args: [BigInt(dataSetId)],
    }),
  )
}
