import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { listAgentNames, agentDir, readAgentClaudeConfigDir } from './agent-config.js'
import { isAgentRunning, stopAgentProcess, startAgentProcess } from './agent-process.js'

const STALE_THRESHOLD_MS = 10 * 60 * 1000  // 10 minutes
const CHECK_INITIAL_DELAY_MS = 90_000       // 90s after startup (agents need time to settle)

function projectsDirForAgent(name: string): string {
  const claudeConfigDir = readAgentClaudeConfigDir(name)
  return claudeConfigDir
    ? join(claudeConfigDir, 'projects')
    : join(homedir(), '.claude', 'projects')
}

function encodedProjectDir(name: string): string {
  return agentDir(name).replace(/\//g, '-')
}

function getLatestJsonlMtime(name: string): number | null {
  try {
    const projectsRoot = projectsDirForAgent(name)
    const projectDir = join(projectsRoot, encodedProjectDir(name))
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
    if (files.length === 0) return null

    let latest = 0
    for (const f of files) {
      try {
        const mtime = statSync(join(projectDir, f)).mtimeMs
        if (mtime > latest) latest = mtime
      } catch { /* file may have vanished */ }
    }
    return latest > 0 ? latest : null
  } catch {
    return null
  }
}

function checkAgent(name: string): void {
  if (!isAgentRunning(name)) return

  const mtime = getLatestJsonlMtime(name)
  if (mtime === null) return

  const staleMs = Date.now() - mtime
  if (staleMs < STALE_THRESHOLD_MS) return

  const staleMin = Math.round(staleMs / 60_000)
  logger.warn({ agent: name, staleMin }, 'orphan-watchdog: agent stale, restarting')

  const stopResult = stopAgentProcess(name)
  if (!stopResult.ok) {
    logger.error({ agent: name, error: stopResult.error }, 'orphan-watchdog: stop failed')
    return
  }

  const startResult = startAgentProcess(name)
  if (startResult.ok) {
    logger.info({ agent: name }, 'orphan-watchdog: agent restarted successfully')
  } else {
    logger.error({ agent: name, error: startResult.error }, 'orphan-watchdog: restart failed')
  }
}

export function startOrphanWatchdog(): NodeJS.Timeout {
  function check() {
    for (const name of listAgentNames()) {
      try {
        checkAgent(name)
      } catch (err) {
        logger.debug({ err, agent: name }, 'orphan-watchdog: check error')
      }
    }
  }

  setTimeout(check, CHECK_INITIAL_DELAY_MS)
  return setInterval(check, 60_000)
}
