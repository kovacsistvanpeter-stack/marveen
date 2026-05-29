/**
 * Context monitor: watches the main agent session's conversation length.
 * When accumulated input tokens exceed the threshold, sends /compact while
 * the session is idle so context never grows past the point where the TUI
 * becomes unresponsive to C-m.
 *
 * Root cause this addresses: OkosTodor's session accumulated 953k tokens
 * before becoming too slow to process scheduled heartbeats (the "97%-os fal").
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { PROJECT_ROOT } from '../config.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { isSessionReadyForPrompt } from './agent-process.js'
import { resolveFromPath } from '../platform.js'

// Trigger /compact when total context tokens exceed this.
// The old session hit 953k before TUI became unresponsive; 150k is
// conservative enough to stay well ahead of the slowdown window.
const COMPACT_THRESHOLD_TOKENS = 150_000

// Only compact once per this window to avoid repeated /compact calls.
const COMPACT_COOLDOWN_MS = 30 * 60 * 1000  // 30 minutes

const TMUX = resolveFromPath('tmux')

// Encoded project root dir (Claude Code convention: / → -)
const ENCODED_PROJECT = PROJECT_ROOT.replace(/\//g, '-')

function getProjectsDir(): string {
  return join(homedir(), '.claude', 'projects')
}

function getLatestJsonlPath(): string | null {
  try {
    const dir = join(getProjectsDir(), ENCODED_PROJECT)
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return files.length > 0 ? join(dir, files[0].name) : null
  } catch {
    return null
  }
}

function getTotalInputTokens(jsonlPath: string): number | null {
  try {
    const content = readFileSync(jsonlPath, 'utf-8')
    const lines = content.trimEnd().split('\n')
    // Scan backwards for the last assistant message with usage
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i])
        if (obj?.type !== 'assistant') continue
        const usage = obj?.message?.usage
        if (!usage) continue
        return (
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0)
        )
      } catch { /* skip malformed line */ }
    }
    return null
  } catch {
    return null
  }
}

let lastCompactAt = 0

function check(): void {
  const now = Date.now()
  if (now - lastCompactAt < COMPACT_COOLDOWN_MS) return

  const jsonlPath = getLatestJsonlPath()
  if (!jsonlPath) return

  const total = getTotalInputTokens(jsonlPath)
  if (total === null) return

  const pct = Math.round(total / 200_000 * 100)
  if (total < COMPACT_THRESHOLD_TOKENS) {
    logger.debug({ total, pct }, 'context-monitor: below threshold')
    return
  }

  if (!isSessionReadyForPrompt(MAIN_CHANNELS_SESSION)) {
    logger.debug({ total, pct }, 'context-monitor: threshold exceeded but session busy, deferring')
    return
  }

  logger.warn({ total, pct }, 'context-monitor: context threshold exceeded, sending /compact')
  lastCompactAt = now

  try {
    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, '-l', '/compact'], { timeout: 5000 })
    execFileSync(TMUX, ['send-keys', '-t', MAIN_CHANNELS_SESSION, 'C-m'], { timeout: 5000 })
    logger.info({ total, pct }, 'context-monitor: /compact sent')
  } catch (err) {
    logger.warn({ err }, 'context-monitor: failed to send /compact')
  }
}

export function startContextMonitor(): NodeJS.Timeout {
  // Initial check after 2 minutes (let the session settle after restart)
  setTimeout(() => {
    try { check() } catch (err) {
      logger.debug({ err }, 'context-monitor: initial check error')
    }
  }, 120_000)

  return setInterval(() => {
    try { check() } catch (err) {
      logger.debug({ err }, 'context-monitor: check error')
    }
  }, 10 * 60 * 1000)  // every 10 minutes
}
