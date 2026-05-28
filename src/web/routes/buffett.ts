import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const DASHBOARD_JSON = join(homedir(), 'projects', 'buffett-pipeline', 'dashboard-data.json')

export async function tryHandleBuffett(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/buffett/portfolio' && method === 'GET') {
    if (!existsSync(DASHBOARD_JSON)) {
      json(res, { portfolios: [], passive: [], refreshed_at: null, _empty: true })
      return true
    }
    try {
      const raw = readFileSync(DASHBOARD_JSON, 'utf-8')
      const data = JSON.parse(raw)
      json(res, data)
    } catch {
      json(res, { error: 'Nem sikerült olvasni a dashboard adatokat' }, 500)
    }
    return true
  }

  return false
}
