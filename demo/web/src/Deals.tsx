import { useEffect, useState } from 'react'
import { api, formatBytes, shortCid, type DealRecord, type DealView, type FileRecord, type Step } from './api.ts'
import { Badge, Button, Card, Check, Copy, ErrorNote, Mono } from './ui.tsx'

export function Deals({ deals, files }: { deals: DealRecord[]; files: FileRecord[] }) {
  return (
    <Card step="3" title="Deale: od manifestu do zaselowanego sektora">
      {deals.length === 0 ? (
        <p className="text-sm text-slate-500">Brak deali. Zleć agregację w kroku 2.</p>
      ) : (
        <div className="space-y-6">
          {deals.map((d) => (
            <DealCard key={d.id} id={d.id} files={files} />
          ))}
        </div>
      )}
    </Card>
  )
}

const stepStyle: Record<Step['state'], string> = {
  done: 'bg-emerald-500 text-white',
  active: 'bg-amber-400 text-white animate-pulse',
  pending: 'bg-slate-200 text-slate-500',
  failed: 'bg-rose-500 text-white',
}

function DealCard({ id, files }: { id: string; files: FileRecord[] }) {
  const [view, setView] = useState<DealView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try {
        const v = await api.deal(id)
        if (stop) return
        setView(v)
        setError(null)
        // Keep polling until the sector is active; afterwards only PDP proving still changes.
        timer = setTimeout(load, v.deal.complete && v.chain?.info ? 30000 : 5000)
      } catch (e) {
        if (!stop) setError((e as Error).message)
        timer = setTimeout(load, 10000)
      }
    }
    void load()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [id])

  async function podsi() {
    setChecking(true)
    setError(null)
    try {
      await api.podsi(id)
      setView(await api.deal(id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  if (!view) return <div className="text-sm text-slate-500">Ładuję deal {id}…</div>
  const { deal, sp, chain, client } = view
  const names = deal.fileIds.map((fid) => files.find((f) => f.id === fid)?.name ?? fid)
  const n = deal.plan.children.length
  const separateNode = view.sp && deal.nodeKey !== 'A'

  return (
    <article className="rounded-lg border border-slate-200">
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3">
        <Mono>{deal.id}</Mono>
        <DealBadge steps={view.steps} />
        <span className="text-sm text-slate-600">
          {names.join(' + ')} → {sp?.node.name ?? deal.provider} ({deal.provider})
        </span>
        <span className="ml-auto text-xs text-slate-400">{new Date(deal.createdAt).toLocaleString()}</span>
      </header>

      <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <ol className="space-y-2">
          {view.steps.map((s, i) => (
            <li key={s.key} className="flex gap-3">
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${stepStyle[s.state]}`}>
                {s.state === 'done' ? '✓' : s.state === 'failed' ? '✗' : i + 1}
              </span>
              <div className="min-w-0">
                <div className={`text-sm ${s.state === 'pending' ? 'text-slate-400' : ''}`}>{s.label}</div>
                {s.detail && <div className="break-all text-xs text-slate-500">{s.detail}</div>}
              </div>
            </li>
          ))}
        </ol>

        <div className="space-y-4">
          <ErrorNote error={error} />
          {sp?.node.problem && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">⚠ {sp.node.problem}</div>}

          <section>
            <h3 className="text-sm font-semibold">Transfer PDP → PoRep</h3>
            <ul className="divide-y divide-slate-100">
              <Check ok={true} label="Klient wysłał do SP tylko manifest: CID, URL w PDP i format każdego pliku" source="klient" />
              {sp && (
                <Check
                  ok={sp.downloads.overlappingDeals.length ? null : sp.downloads.ok >= n ? sp.downloads.ok === n : null}
                  label={`${separateNode ? 'Osobny SP pobrał' : 'SP pobrał'} pliki z /piece/ SP PDP: ${sp.downloads.ok} udanych zadań pobrania (ParkPiece) na ${n} plików`}
                  detail={[
                    sp.downloads.overlappingDeals.length
                      ? `w tym samym czasie węzeł obsługiwał też deal ${sp.downloads.overlappingDeals.join(', ')}, więc licznik nie jest jednoznaczny`
                      : 'liczone na węźle od przyjęcia deala do złożenia agregatu; oczekiwane: jedno zadanie na plik',
                    'jedno zadanie może ponowić żądanie HTTP (Range), gdy transfer się przerwie',
                    separateNode ? '' : 'ten sam Curio jest SP PDP i SP PoRep, więc pobiera od siebie',
                  ]
                    .filter(Boolean)
                    .join('; ')}
                  source={`baza SP (${sp.node.name})`}
                />
              )}
              {sp?.errors.map((e, i) => (
                <Check key={i} ok={false} label={`${e.name} odrzucił dane`} detail={e.err} source="baza SP" />
              ))}
              <Check
                ok={client.status ? client.status !== 'failed' : null}
                label={`Status deala u SP (API mk20 klienta): ${client.status ?? `HTTP ${client.http}`}`}
                detail={client.errorMsg || client.raw}
                source="klient → SP"
              />
            </ul>
          </section>

          <section>
            <h3 className="text-sm font-semibold">On-chain</h3>
            {chain ? (
              <ul className="divide-y divide-slate-100">
                <Check
                  ok={chain.preCommit ? chain.preCommit.exitCode === 0 : null}
                  label={`PreCommit sektora ${chain.sector} przyjęty on-chain (exit code ${chain.preCommit?.exitCode ?? '…'}): UnsealedCid (CommD)`}
                  detail={chain.preCommit ? <Mono>{chain.preCommit.unsealedCid}</Mono> : 'czekam na wiadomość'}
                  source="wiadomość on-chain"
                />
                <Check
                  ok={chain.proveCommit ? chain.pieceIsAggregate : null}
                  label="ProveCommit: kawałek sektora to dokładnie zaplanowany agregat"
                  detail={
                    chain.proveCommit
                      ? chain.proveCommit.pieces.map((p) => `${shortCid(p.cid)} · ${formatBytes(p.size)} · datacap: ${p.verifiedAllocation === null ? 'brak' : 'tak'}`).join('; ')
                      : 'czekam na wiadomość'
                  }
                  source="wiadomość on-chain"
                />
                <Check
                  ok={chain.info ? true : null}
                  label="Sektor istnieje w stanie minera"
                  detail={chain.info ? `aktywacja ${chain.info.activation}, wygasa ${chain.info.expiration}, CommR ${shortCid(chain.info.sealedCid)}` : undefined}
                  source="stan on-chain"
                />
                {view.pdp.map((p) => (
                  <Check
                    key={p.dataSetId}
                    ok={p.lastProvenEpoch !== null && p.lastProvenEpoch > p.sinceHeight ? true : null}
                    label={
                      p.lastProvenEpoch !== null && p.lastProvenEpoch > p.sinceHeight
                        ? `PDP dalej dowodzi data setu ${p.dataSetId} (dowód po zleceniu deala)`
                        : `Czekam na dowód PDP data setu ${p.dataSetId} po zleceniu deala`
                    }
                    detail={`ostatni dowód: epoka ${p.lastProvenEpoch}, deal zlecony w epoce ${p.sinceHeight}`}
                    source="PDPVerifier"
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-500">Sektor jeszcze nie jest znany.</p>
            )}
          </section>

          <section className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Weryfikacja PoDSI (niezależna, po stronie klienta)</h3>
                <p className="text-xs text-slate-500">Pobiera agregat od SP PoRep przez /piece/ i sprawdza go biblioteką go-data-segment (tą samą co Curio).</p>
              </div>
              <Button variant="secondary" onClick={podsi} disabled={checking || view.steps[view.steps.length - 1]?.state !== 'done'}>
                {checking ? 'Sprawdzam…' : deal.podsi ? 'Sprawdź ponownie' : 'Zweryfikuj PoDSI'}
              </Button>
            </div>
            {deal.podsi && <PodsiResult podsi={deal.podsi} names={names} plan={deal.plan} />}
          </section>
        </div>
      </div>
    </article>
  )
}

function PodsiResult({ podsi, names, plan }: { podsi: NonNullable<DealRecord['podsi']>; names: string[]; plan: DealRecord['plan'] }) {
  const lines = podsi.output.split('\n')
  const proofs = lines.filter((l) => l.startsWith('== inclusion proof'))
  const sector = lines.find((l) => l.includes('equals on-chain UnsealedCid'))
  const segments = lines.filter((l) => /^\s+\[\d+\] CommP=/.test(l)).length
  const whole = lines.find((l) => l.startsWith('== aggregate file:'))
  return (
    <div className="mt-3 space-y-2">
      <ul className="divide-y divide-slate-100">
        <Check
          ok={Boolean(whole?.endsWith('true'))}
          label={`Pobrany od SP plik (${formatBytes(podsi.aggregateBytes ?? 0)}) to dokładnie zaplanowany agregat: CommP wszystkich bajtów = CID agregatu`}
          detail={`sha256 ${podsi.aggregateSha256?.slice(0, 16)}…`}
          source="SP PoRep /piece/ + podsicheck"
        />
        <Check ok={segments === plan.children.length} label={`Indeks PoDSI ma ${segments} wpisy, a CommP każdego segmentu zgadza się z jego bajtami`} source="podsicheck" />
        {plan.children.map((c, i) => (
          <Check
            key={c.pieceCidV2}
            ok={proofs.some((p) => p.includes(c.pieceCidV1) && p.includes('VERIFIED=true'))}
            label={`Dowód włączenia: ${names[i]} jest w agregacie`}
            detail={<Mono>{c.pieceCidV2}</Mono>}
            source="podsicheck"
          />
        ))}
        <Check ok={Boolean(sector?.endsWith('true'))} label="CommD sektora (agregat + zera) = UnsealedCid zapisany on-chain" source="podsicheck + łańcuch" />
      </ul>
      <Badge tone={podsi.ok ? 'green' : 'red'}>{podsi.ok ? 'PoDSI OK' : 'PoDSI: błąd'}</Badge>
      <details>
        <summary className="cursor-pointer text-xs text-slate-500">pełny wynik podsicheck</summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{podsi.output}</pre>
        <Copy text={podsi.output} />
      </details>
    </div>
  )
}

function DealBadge({ steps }: { steps: Step[] }) {
  if (steps.some((s) => s.state === 'failed')) return <Badge tone="red">błąd</Badge>
  if (steps[steps.length - 1]?.state === 'done') return <Badge tone="green">zaselowane</Badge>
  return <Badge tone="amber">w toku</Badge>
}
