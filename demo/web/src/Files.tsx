import { useRef, useState } from 'react'
import { api, formatBytes, shortCid, type FileRecord, type FileVerification } from './api.ts'
import { Badge, Button, Card, Check, Copy, ErrorNote, Mono } from './ui.tsx'

const statusLabel: Record<FileRecord['status'], [string, 'slate' | 'amber' | 'green' | 'red' | 'blue']> = {
  queued: ['w kolejce', 'slate'],
  uploading: ['wysyłanie', 'amber'],
  stored: ['SP ma bajty', 'amber'],
  committing: ['zapis on-chain', 'blue'],
  ready: ['gotowe w PDP', 'green'],
  failed: ['błąd', 'red'],
}

export function Files({
  files,
  selected,
  onToggle,
  onUploaded,
  limits,
}: {
  files: FileRecord[]
  selected: string[]
  onToggle: (id: string) => void
  onUploaded: () => void
  limits?: { minFileBytes: number; maxFileBytes: number }
}) {
  const input = useRef<HTMLInputElement>(null)
  const [format, setFormat] = useState('auto')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  async function upload(list: FileList | null) {
    if (!list?.length) return
    setBusy(true)
    setError(null)
    try {
      for (const f of Array.from(list)) await api.upload(f, format)
      onUploaded()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  return (
    <Card step="1" title="Twoje pliki w PDP (Synapse → Curio PDP)">
      <div
        className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 p-4"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault()
          void upload(e.dataTransfer.files)
        }}
      >
        <input ref={input} type="file" multiple className="hidden" onChange={(e) => void upload(e.target.files)} />
        <Button onClick={() => input.current?.click()} disabled={busy}>
          {busy ? 'Wysyłanie…' : 'Wybierz pliki'}
        </Button>
        <span className="text-sm text-slate-600">albo upuść je tutaj.</span>
        <label className="ml-auto flex items-center gap-2 text-sm text-slate-600">
          format
          <select className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="auto">wykryj (CAR albo raw)</option>
            <option value="raw">raw (dowolne bajty)</option>
            <option value="car">CAR</option>
          </select>
        </label>
        {limits && (
          <p className="w-full text-xs text-slate-500">
            Od {limits.minFileBytes} B do {formatBytes(limits.maxFileBytes)} na plik: sektory devnetu mają 8 MiB, a agregat musi się w nim zmieścić.
          </p>
        )}
      </div>
      <div className="mt-3">
        <ErrorNote error={error} />
      </div>

      {files.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">Brak plików. Wrzuć co najmniej dwa, żeby zrobić z nich agregat.</p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-8 py-2" />
              <th>plik</th>
              <th>format</th>
              <th>status</th>
              <th>PieceCID</th>
              <th>data set / pieceId</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const [label, tone] = statusLabel[f.status]
              const isOpen = open === f.id
              return (
                <FileRow key={f.id} f={f} label={label} tone={tone} isOpen={isOpen} selected={selected} onToggle={onToggle} onOpen={() => setOpen(isOpen ? null : f.id)} />
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function FileRow({
  f,
  label,
  tone,
  isOpen,
  selected,
  onToggle,
  onOpen,
}: {
  f: FileRecord
  label: string
  tone: 'slate' | 'amber' | 'green' | 'red' | 'blue'
  isOpen: boolean
  selected: string[]
  onToggle: (id: string) => void
  onOpen: () => void
}) {
  const order = selected.indexOf(f.id)
  return (
    <>
      <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={onOpen}>
        <td className="py-2" onClick={(e) => e.stopPropagation()}>
          <label className="flex items-center gap-1">
            <input type="checkbox" disabled={f.status !== 'ready'} checked={order >= 0} onChange={() => onToggle(f.id)} />
            {order >= 0 && <span className="text-xs text-slate-500">{order + 1}</span>}
          </label>
        </td>
        <td className="py-2">
          <div className="font-medium">{f.name}</div>
          <div className="text-xs text-slate-500">{formatBytes(f.size)}</div>
        </td>
        <td>{f.format === 'raw' ? <Badge tone="violet">raw</Badge> : <Badge tone="blue">CAR</Badge>}</td>
        <td>
          <Badge tone={tone}>{label}</Badge>
        </td>
        <td>
          <Mono title={f.pieceCid}>{shortCid(f.pieceCid ?? f.localPieceCid)}</Mono>
        </td>
        <td className="text-xs text-slate-600">{f.dataSetId !== undefined ? `${f.dataSetId} / ${f.pieceId}` : '—'}</td>
        <td className="text-right text-xs text-slate-400">{isOpen ? 'zwiń' : 'szczegóły'}</td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={7} className="bg-slate-50 px-4 py-4">
            <FileDetails f={f} />
          </td>
        </tr>
      )}
    </>
  )
}

function FileDetails({ f }: { f: FileRecord }) {
  const [v, setV] = useState<FileVerification | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function verify() {
    setBusy(true)
    setError(null)
    try {
      setV(await api.verifyFile(f.id))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Co się działo</h3>
          {f.status === 'failed' && (
            <Button variant="secondary" onClick={() => void api.retry(f.id)}>
              Ponów upload
            </Button>
          )}
        </div>
        <ol className="space-y-1 border-l-2 border-slate-200 pl-3 text-xs text-slate-600">
          {f.events.map((e, i) => (
            <li key={i}>
              <span className="text-slate-400">{new Date(e.at).toLocaleTimeString()}</span> {e.text}
            </li>
          ))}
        </ol>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-slate-500">PieceCID</dt>
          <dd>
            <Mono>{f.pieceCid ?? '—'}</Mono> {f.pieceCid && <Copy text={f.pieceCid} />}
          </dd>
          <dt className="text-slate-500">SHA-256</dt>
          <dd>
            <Mono>{f.sha256}</Mono>
          </dd>
          <dt className="text-slate-500">URL w PDP</dt>
          <dd>
            <Mono>{f.retrievalUrl ?? '—'}</Mono>
          </dd>
          {f.txHash && (
            <>
              <dt className="text-slate-500">tx</dt>
              <dd>
                <Mono>{f.txHash}</Mono>
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Sprawdź sam (klient)</h3>
          <Button variant="secondary" onClick={verify} disabled={busy || f.status !== 'ready'}>
            {busy ? 'Sprawdzam…' : 'Sprawdź teraz'}
          </Button>
        </div>
        <ErrorNote error={error} />
        {v && (
          <>
            <ul className="divide-y divide-slate-100">
              <Check
                ok={f.localPieceCid === f.pieceCid}
                label="PieceCID policzony lokalnie = PieceCID potwierdzony przez SP"
                source="klient"
              />
              <Check
                ok={v.piece.matchesOriginal}
                label="Bajty z /piece/ są identyczne z oryginałem"
                detail={`HTTP ${v.piece.httpStatus}, ${formatBytes(v.piece.bytes)}, sha256 ${v.piece.sha256.slice(0, 16)}…`}
                source="SP PDP"
              />
              <Check ok={v.chain.pieceCidMatches} label="PDPVerifier zapisał dokładnie ten PieceCID" detail={<Mono>{v.chain.onChainPieceCid}</Mono>} source="on-chain" />
              <Check ok={v.chain.pieceLive && v.chain.dataSetLive} label={`Kawałek ${f.pieceId} w data secie ${f.dataSetId} jest aktywny`} source="on-chain" />
              <Check
                ok={f.addedHeight !== undefined && v.chain.lastProvenEpoch > f.addedHeight ? true : null}
                label={
                  f.addedHeight !== undefined && v.chain.lastProvenEpoch > f.addedHeight
                    ? 'Dowód PDP data setu powstał już po dodaniu tego pliku'
                    : 'Czekam na pierwszy dowód PDP data setu po dodaniu tego pliku'
                }
                detail={`ostatni dowód data setu: epoka ${v.chain.lastProvenEpoch}, plik dodany ok. epoki ${f.addedHeight ?? '?'}, następne wyzwanie: ${v.chain.nextChallengeEpoch}, teraz: ${v.chain.height}`}
                source="on-chain"
              />
            </ul>
            <div>
              <h4 className="mb-1 text-xs font-semibold text-slate-500">Te same sprawdzenia z terminala</h4>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{v.commands.join('\n')}</pre>
              <Copy text={v.commands.join('\n')} label="kopiuj komendy" />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
