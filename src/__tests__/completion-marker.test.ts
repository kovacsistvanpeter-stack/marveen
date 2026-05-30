import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isoWeek, resolveMarkerPath, markerSatisfied, catchupWindowOpen, cronDueThisIsoWeek } from '../web/completion-marker.js'

describe('isoWeek', () => {
  it('matches GNU date +%G-W%V for known dates', () => {
    expect(isoWeek(new Date('2026-05-30T12:00:00'))).toBe('2026-W22') // the missed Saturday
    expect(isoWeek(new Date('2026-01-01T12:00:00'))).toBe('2026-W01')
    expect(isoWeek(new Date('2025-12-29T12:00:00'))).toBe('2026-W01') // ISO year rollover
    expect(isoWeek(new Date('2026-12-31T12:00:00'))).toBe('2026-W53')
  })
})

describe('resolveMarkerPath', () => {
  it('substitutes {ISO_WEEK}', () => {
    expect(resolveMarkerPath('/x/{ISO_WEEK}.flag', new Date('2026-05-30T12:00:00')))
      .toBe('/x/2026-W22.flag')
  })
})

describe('markerSatisfied', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  it('is true only once the ISO-week flag file exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'cm-'))
    mkdirSync(join(dir, 'weekly_sent'), { recursive: true })
    const tmpl = join(dir, 'weekly_sent', '{ISO_WEEK}.flag')
    const now = new Date('2026-05-30T12:00:00')
    expect(markerSatisfied(tmpl, now)).toBe(false)
    writeFileSync(resolveMarkerPath(tmpl, now), '')
    expect(markerSatisfied(tmpl, now)).toBe(true)
    // a different week is still unsatisfied
    expect(markerSatisfied(tmpl, new Date('2026-06-06T12:00:00'))).toBe(false)
  })
})

describe('catchupWindowOpen', () => {
  it('stays open within the same ISO week and closes in the next', () => {
    const sat0100 = new Date('2026-05-30T01:00:00').getTime()
    expect(catchupWindowOpen(sat0100, new Date('2026-05-31T23:00:00').getTime())).toBe(true)  // Sunday same week
    expect(catchupWindowOpen(sat0100, new Date('2026-06-01T09:00:00').getTime())).toBe(false) // Monday, next week
  })
})

describe('cronDueThisIsoWeek', () => {
  const weekly = '0 1 * * 6' // Saturday 01:00
  it('recovers a missed weekly tick anywhere in the same ISO week', () => {
    expect(cronDueThisIsoWeek(weekly, new Date('2026-05-30T14:00:00').getTime())).toBe(true)  // Sat, after the cron minute
    expect(cronDueThisIsoWeek(weekly, new Date('2026-05-31T23:00:00').getTime())).toBe(true)  // Sun, window still open
    expect(cronDueThisIsoWeek(weekly, new Date('2026-05-30T00:30:00').getTime())).toBe(false) // before the cron fired
    expect(cronDueThisIsoWeek(weekly, new Date('2026-05-29T20:00:00').getTime())).toBe(false) // Fri, not yet due
    expect(cronDueThisIsoWeek(weekly, new Date('2026-06-01T09:00:00').getTime())).toBe(false) // Mon, window closed
  })
})
