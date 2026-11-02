import { useCallback, useEffect, useState } from 'react'
import { api, type DealRecord, type FileRecord, type Status } from './api.ts'
import { AggregatePanel } from './Aggregate.tsx'
import { Deals } from './Deals.tsx'
import { Files } from './Files.tsx'
import { Badge, Mono } from './ui.tsx'

export function App() {
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [files, setFiles] = useState<FileRecord[]>([])
  const [deals, setDeals] = useState<DealRecord[]>([])
  const [selected, setSelected] = useState<string[]>([])

  const refresh = useCallback(async () => {
    try {
      const [s, f, d] = await Promise.all([api.status(), api.files(), api.deals()])
      setStatus(s)
      setFiles(f)
      setDeals(d)
      setStatusError(null)
    } catch (e) {
      setStatusError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <header className="space-y-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Twoje pliki: PDP → agregat PoDSI → sektor PoRep</h1>
          <p className="mt-1 text-sm text-slate-600">
            Demo na lokalnym devnecie Filecoin (NV29, Curio v1.29.0, Synapse SDK v2.0.2). Każdy krok pokazuje, co mówi klient, co widzi SP i co
            jest zapisane on-chain.
          </p>
        </div>
        {statusError && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">Brak połączenia z devnetem: {statusError}</div>}
        {status && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="blue">epoka {status.height}</Badge>
            <Badge tone="blue">NV{status.networkVersion}</Badge>
            <span className="text-slate-500">klient:</span>
            <Mono title={status.client.filecoin}>{status.client.evm}</Mono>
            {status.nodes.map((n) => (
              <span key={n.key} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1">
                <span className={`h-2 w-2 rounded-full ${n.available && !n.problem ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                <span className="font-medium">{n.name}</span>
                <span className="text-slate-500">{n.miner ?? 'niedostępny'}</span>
                {n.pdp ? <Badge tone="violet">PDP + PoRep</Badge> : <Badge>PoRep</Badge>}
              </span>
            ))}
          </div>
        )}
        {status && status.chain.lagSeconds > 120 && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
            ⚠ Łańcuch devnetu stoi {Math.round(status.chain.lagSeconds / 60)} min za zegarem ({status.chain.lagEpochs} epok).{' '}
            {status.chain.stuckForever
              ? 'To więcej niż 900 epok: Lotus nie wydobędzie już bloku, devnet trzeba postawić od nowa (just reset). Zwykle to skutek uśpienia komputera.'
              : 'Zwykle nadrabia w kilka minut. Do tego czasu Curio odrzuca uploady PDP (503).'}
          </div>
        )}
        {status?.pdpProviders
          .filter((p) => !p.ok)
          .map((p) => (
            <div key={p.providerId} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              ⚠ SP PDP {p.providerId} ({p.url}) nie przyjmuje uploadów: {p.detail}
            </div>
          ))}
        {status?.nodes
          .filter((n) => n.problem)
          .map((n) => (
            <div key={n.key} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              ⚠ {n.name}: {n.problem}
            </div>
          ))}
      </header>

      <Files files={files} selected={selected} onToggle={toggle} onUploaded={refresh} limits={status?.limits} />
      <AggregatePanel files={files} selected={selected} setSelected={setSelected} nodes={status?.nodes ?? []} onDeal={refresh} />
      <Deals deals={deals} files={files} />
    </div>
  )
}
