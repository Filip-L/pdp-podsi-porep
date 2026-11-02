import { useState, type ReactNode } from 'react'

export function Card({ title, step, children, aside }: { title: string; step?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-3">
        <h2 className="flex items-center gap-3 text-base font-semibold">
          {step && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs text-white">{step}</span>}
          {title}
        </h2>
        {aside}
      </header>
      <div className="p-5">{children}</div>
    </section>
  )
}

const tones = {
  slate: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-100 text-emerald-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-rose-100 text-rose-800',
  blue: 'bg-sky-100 text-sky-800',
  violet: 'bg-violet-100 text-violet-800',
}

export function Badge({ tone = 'slate', children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code title={title} className="break-all font-mono text-xs text-slate-700">
      {children}
    </code>
  )
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-900"
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? 'skopiowano' : (label ?? 'kopiuj')}
    </button>
  )
}

// One verifiable claim: a check mark, what is claimed, and where the evidence came from.
export function Check({ ok, label, detail, source }: { ok: boolean | null; label: string; detail?: ReactNode; source?: string }) {
  const icon = ok === null ? '…' : ok ? '✓' : '✗'
  const color = ok === null ? 'text-slate-400' : ok ? 'text-emerald-600' : 'text-rose-600'
  return (
    <li className="flex gap-3 py-1.5">
      <span className={`w-4 shrink-0 text-center font-bold ${color}`}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          {label}
          {source && <span className="ml-2 text-xs text-slate-400">źródło: {source}</span>}
        </div>
        {detail && <div className="mt-0.5 text-xs text-slate-500">{detail}</div>}
      </div>
    </li>
  )
}

export function Button({
  children,
  onClick,
  disabled,
  variant = 'primary',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary'
}) {
  const style =
    variant === 'primary'
      ? 'bg-slate-900 text-white hover:bg-slate-700 disabled:bg-slate-300'
      : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:text-slate-300'
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`rounded-lg px-3.5 py-2 text-sm font-medium transition ${style}`}>
      {children}
    </button>
  )
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null
  return <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</div>
}
