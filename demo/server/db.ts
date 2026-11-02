import pg from 'pg'
import { config } from './config.ts'

// One pool per HarmonyDB database (one per Curio node). These reads are the SP-side view:
// a real client would not have them, so the UI labels them as such.
const pools = new Map<string, pg.Pool>()

function pool(database: string): pg.Pool {
  let p = pools.get(database)
  if (!p) {
    p = new pg.Pool({ ...config.db, database, max: 4, connectionTimeoutMillis: 5000 })
    p.on('error', () => {})
    pools.set(database, p)
  }
  return p
}

export async function query<T = any>(database: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool(database).query(sql, params)
  return res.rows as T[]
}
