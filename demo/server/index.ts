import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { CarReader } from '@ipld/car'
import { config } from './config.ts'
import { createDeal, dealView, planFor } from './deals.ts'
import { chainLag, networkVersion } from './lotus.ts'
import { clientAddress } from './mk20.ts'
import { getNodes } from './nodes.ts'
import { devnet, enqueueUpload, pdpHealth, pdpVerifierAddress, verifyFile } from './pdp.ts'
import { verifyPodsi } from './podsi.ts'
import { event, filePath, save, state, syncRun, type FileFormat, type FileRecord } from './store.ts'

const app = new Hono()

app.onError((err, c) => c.json({ error: err.message }, 400))

app.use('/api/*', async (_c, next) => {
  syncRun(devnet().runId)
  await next()
})

app.get('/api/status', async (c) => {
  const { info } = devnet()
  const [lag, nv, nodes, pdp] = await Promise.all([chainLag(), networkVersion(), getNodes(true), pdpHealth()])
  return c.json({
    runId: info.info.run_id,
    height: lag.height,
    chain: lag,
    networkVersion: nv,
    client: { evm: info.info.users[0].evm_addr, filecoin: clientAddress() },
    pdpVerifier: pdpVerifierAddress(),
    pdpProviders: pdp,
    nodes,
    limits: { minFileBytes: config.minFileBytes, maxFileBytes: config.maxFileBytes },
  })
})

app.get('/api/files', (c) => c.json(state.files))

// A file is treated as CAR only if it parses as one (header and every block); anything else is raw.
async function isCar(b: Uint8Array): Promise<boolean> {
  try {
    const reader = await CarReader.fromBytes(b)
    for await (const _ of reader.blocks()) {
      // parsing every block validates the whole file
    }
    return true
  } catch {
    return false
  }
}

app.post('/api/files', async (c) => {
  const form = await c.req.parseBody()
  const file = form.file
  if (!(file instanceof File)) throw new Error('brak pliku')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length < config.minFileBytes) throw new Error(`plik musi mieć co najmniej ${config.minFileBytes} B (minimum PDP)`)
  if (bytes.length > config.maxFileBytes) throw new Error(`plik może mieć najwyżej ${config.maxFileBytes} B (sektory devnetu mają 8 MiB)`)
  const requested = form.format
  const parsesAsCar = await isCar(bytes)
  if (requested === 'car' && !parsesAsCar) throw new Error('plik nie jest poprawnym CAR-em; wybierz format raw albo „wykryj”')
  const format: FileFormat = requested === 'raw' ? 'raw' : parsesAsCar ? 'car' : 'raw'
  const rec: FileRecord = {
    id: randomUUID(),
    name: file.name,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    format,
    createdAt: new Date().toISOString(),
    status: 'queued',
    events: [],
  }
  await writeFile(filePath(rec.id), bytes)
  state.files.unshift(rec)
  event(rec, `Przyjęto plik ${rec.name} (${rec.size} B, format ${format}, sha256 ${rec.sha256.slice(0, 16)}…)`)
  if (/\.car$/i.test(rec.name) && !parsesAsCar) {
    event(rec, 'Uwaga: plik ma rozszerzenie .car, ale jego zawartość nie jest CAR-em (brak nagłówka z roots i bloków IPLD), więc trafia jako raw. Prawdziwy CAR: npx ipfs-car pack <plik> --output <plik>.car')
  }
  enqueueUpload(rec)
  return c.json(rec)
})

app.post('/api/files/:id/retry', (c) => {
  const rec = state.files.find((f) => f.id === c.req.param('id'))
  if (!rec) return c.json({ error: 'nie ma takiego pliku' }, 404)
  if (rec.status !== 'failed') throw new Error('ponowić można tylko nieudany upload')
  rec.status = 'queued'
  rec.error = undefined
  event(rec, 'Ponawiam upload')
  enqueueUpload(rec)
  return c.json(rec)
})

app.get('/api/files/:id/verify', async (c) => {
  const rec = state.files.find((f) => f.id === c.req.param('id'))
  if (!rec) return c.json({ error: 'nie ma takiego pliku' }, 404)
  return c.json(await verifyFile(rec))
})

app.post('/api/plan', async (c) => {
  const { fileIds } = await c.req.json<{ fileIds: string[] }>()
  return c.json(await planFor(fileIds))
})

app.get('/api/deals', (c) => c.json(state.deals))

app.post('/api/deals', async (c) => {
  const { fileIds, provider } = await c.req.json<{ fileIds: string[]; provider: string }>()
  return c.json(await createDeal(fileIds, provider))
})

app.get('/api/deals/:id', async (c) => {
  const deal = state.deals.find((d) => d.id === c.req.param('id'))
  if (!deal) return c.json({ error: 'nie ma takiego deala' }, 404)
  return c.json(await dealView(deal))
})

app.post('/api/deals/:id/podsi', async (c) => {
  const deal = state.deals.find((d) => d.id === c.req.param('id'))
  if (!deal) return c.json({ error: 'nie ma takiego deala' }, 404)
  const view = await dealView(deal)
  if (view.steps[view.steps.length - 1]?.state !== 'done') throw new Error('SP jeszcze nie zakończył deala (indeksowanie); agregat będzie dostępny przez /piece/ po zakończeniu')
  const preCommit = view.chain?.preCommit
  // Only a PreCommit the chain accepted (exit code 0) gives the sector's CommD.
  if (!preCommit?.unsealedCid || preCommit.exitCode !== 0) throw new Error('brak przyjętego on-chain PreCommit sektora (exit code 0)')
  const unsealed = preCommit.unsealedCid
  deal.podsi = await verifyPodsi(deal, view.chain.sectorSize, unsealed)
  save()
  return c.json(deal.podsi)
})

app.use('/*', serveStatic({ root: config.webDir }))
app.get('/*', serveStatic({ path: `${config.webDir}/index.html` }))

serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`demo: http://localhost:${i.port}`))
