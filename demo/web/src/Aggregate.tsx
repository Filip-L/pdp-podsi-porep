import { useEffect, useState } from 'react'
import { api, formatBytes, shortCid, type AggregatePlan, type FileRecord, type NodeView } from './api.ts'
import { Badge, Button, Card, Copy, ErrorNote, Mono } from './ui.tsx'

const colors = ['bg-violet-400', 'bg-sky-400', 'bg-emerald-400', 'bg-amber-400', 'bg-rose-400', 'bg-teal-400']

export function AggregatePanel({
  files,
  selected,
  setSelected,
  nodes,
  onDeal,
}: {
  files: FileRecord[]
  selected: string[]
  setSelected: (ids: string[]) => void
  nodes: NodeView[]
  onDeal: () => void
}) {
  const [plan, setPlan] = useState<{ plan: AggregatePlan; sectorSizes: { miner: string; sectorSize: number }[] } | null>(null)
  const [provider, setProvider] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chosen = selected.map((id) => files.find((f) => f.id === id)).filter(Boolean) as FileRecord[]
  const sps = nodes.filter((n) => n.available && n.miner)

  useEffect(() => {
    if (!provider && sps.length) setProvider((sps.find((n) => !n.pdp) ?? sps[0]).miner!)
  }, [provider, sps])

  useEffect(() => {
    setError(null)
    if (selected.length < 2) {
      setPlan(null)
      return
    }
    api.plan(selected).then(setPlan, (e) => {
      setPlan(null)
      setError((e as Error).message)
    })
  }, [selected.join(',')])

  const sectorSize = plan?.sectorSizes.find((s) => s.miner === provider)?.sectorSize
  const fits = plan && sectorSize ? plan.plan.pieceSize <= sectorSize : false
  const node = sps.find((n) => n.miner === provider)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await api.createDeal(selected, provider)
      setSelected([])
      onDeal()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card step="2" title="Agregat PoDSI i zlecenie sealingu (PoRep)">
      {chosen.length < 2 ? (
        <p className="text-sm text-slate-500">Zaznacz w tabeli powyżej co najmniej dwa pliki gotowe w PDP. Kolejność zaznaczania = kolejność w agregacie.</p>
      ) : (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Agregat policzony przez klienta, zanim cokolwiek zostanie wysłane</h3>
            <p className="mb-3 text-xs text-slate-500">
              PoDSI (FRC-0058): CID agregatu i położenie każdego pliku wynikają z samych PieceCID plików. Klient zna wynik z góry, a SP musi zbudować dokładnie
              ten agregat.
            </p>
            {plan ? (
              <>
                <Layout plan={plan.plan} files={chosen} />
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-slate-500">CID agregatu</dt>
                  <dd>
                    <Mono>{plan.plan.aggregateCidV2}</Mono> <Copy text={plan.plan.aggregateCidV2} />
                  </dd>
                  <dt className="text-slate-500">rozmiar</dt>
                  <dd>
                    {formatBytes(plan.plan.pieceSize)} po paddingu, indeks PoDSI na końcu (do {plan.plan.maxIndexEntries} wpisów)
                  </dd>
                </dl>
              </>
            ) : (
              <p className="text-sm text-slate-500">Liczę…</p>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 pt-4">
            <label className="text-sm">
              <div className="mb-1 font-medium">SP do sealingu (PoRep)</div>
              <select className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={provider} onChange={(e) => setProvider(e.target.value)}>
                {sps.map((n) => (
                  <option key={n.key} value={n.miner}>
                    {n.name} · {n.miner} · {n.pdp ? 'ten sam SP co PDP' : 'osobny SP, pobierze pliki z PDP'}
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={submit} disabled={!plan || !fits || busy || !provider}>
              {busy ? 'Wysyłanie deala…' : 'Agreguj i zaseluj'}
            </Button>
            {plan && sectorSize !== undefined && (
              <span className="text-xs text-slate-500">
                sektor {formatBytes(sectorSize)}: {fits ? <Badge tone="green">agregat się mieści</Badge> : <Badge tone="red">agregat za duży</Badge>}
              </span>
            )}
          </div>
          {node && (
            <p className="text-xs text-slate-500">
              Do {node.name} trafi tylko manifest (CID + URL w PDP + format). Pliki pobierze sam z <Mono>/piece/</Mono> SP PDP i sprawdzi ich CommP.
            </p>
          )}
        </div>
      )}
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>
    </Card>
  )
}

// The aggregate as a bar: every file gets a power-of-two slot; the index sits at the end.
function Layout({ plan, files }: { plan: AggregatePlan; files: FileRecord[] }) {
  const pct = (n: number) => `${(n / plan.pieceSize) * 100}%`
  return (
    <div>
      <div className="relative h-9 overflow-hidden rounded-md bg-slate-100">
        {plan.children.map((c, i) => (
          <div
            key={c.pieceCidV2}
            className={`absolute top-0 h-full ${colors[i % colors.length]} opacity-30`}
            style={{ left: pct(c.offset), width: pct(c.paddedSize) }}
          />
        ))}
        {plan.children.map((c, i) => (
          <div
            key={c.pieceCidV2 + 'data'}
            title={files[i]?.name}
            className={`absolute top-0 h-full ${colors[i % colors.length]}`}
            style={{ left: pct(c.offset), width: pct((c.payloadSize * 128) / 127) }}
          />
        ))}
        <div className="absolute right-0 top-0 h-full w-1 bg-slate-900" title="indeks PoDSI" />
      </div>
      <ul className="mt-2 space-y-1 text-xs">
        {plan.children.map((c, i) => (
          <li key={c.pieceCidV2} className="flex flex-wrap items-center gap-2">
            <span className={`h-3 w-3 rounded-sm ${colors[i % colors.length]}`} />
            <span className="font-medium">{files[i]?.name}</span>
            <span className="text-slate-500">
              offset {formatBytes(c.offset)}, slot {formatBytes(c.paddedSize)}, dane {formatBytes(c.payloadSize)}
            </span>
            <Badge tone={files[i]?.format === 'raw' ? 'violet' : 'blue'}>{files[i]?.format}</Badge>
            <Mono>{shortCid(c.pieceCidV2)}</Mono>
          </li>
        ))}
        <li className="flex items-center gap-2 text-slate-500">
          <span className="h-3 w-3 rounded-sm bg-slate-900" /> indeks PoDSI od offsetu {formatBytes(plan.indexOffset)}
        </li>
      </ul>
    </div>
  )
}
