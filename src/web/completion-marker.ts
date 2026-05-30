import { existsSync } from 'node:fs'
import { CronExpressionParser } from 'cron-parser'

// Idempotency for must-not-miss scheduled tasks (the weekly Buffett letter).
// A task carries a `completionMarker` path template containing "{ISO_WEEK}";
// the task writes that file only after its real work succeeds. The runner
// treats the task as done-for-the-week when the file exists, and keeps
// re-attempting while it is absent and we are still in the same ISO week as
// the queued attempt. Pure functions here so the week math is unit-testable.

// ISO-8601 week string, e.g. "2026-W22", from local calendar date. Uses the
// standard "Thursday of the week decides the year" rule. Computed in UTC off
// the local Y/M/D so a DST shift never moves a date across a week boundary.
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = (date.getUTCDay() + 6) % 7 // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // move to Thursday
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ftDayNum + 3)
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

// Replace "{ISO_WEEK}" in the template with the current ISO week.
export function resolveMarkerPath(template: string, now: Date): string {
  return template.replace(/\{ISO_WEEK\}/g, isoWeek(now))
}

// True when the task has already completed for the current ISO week.
export function markerSatisfied(template: string, now: Date): boolean {
  try {
    return existsSync(resolveMarkerPath(template, now))
  } catch {
    return false
  }
}

// The catch-up window stays open only within the SAME ISO week the attempt was
// first queued in. Once the calendar crosses into the next ISO week without
// the marker, the window has closed: stop retrying the stale attempt (the next
// cron tick opens a fresh one for the new week) so a missed letter never
// bleeds into the following week.
export function catchupWindowOpen(firstAttemptMs: number, nowMs: number): boolean {
  return isoWeek(new Date(firstAttemptMs)) === isoWeek(new Date(nowMs))
}

// True when the cron's most recent scheduled fire falls in the CURRENT ISO
// week -- i.e. the task is "due this week" and we are still inside the catch-up
// window. This is what lets the runner recover a tick that was missed entirely
// (e.g. the dashboard process was down at 01:00 Saturday): hours later the
// prev-fire is still this week, so the task can be queued instead of waiting a
// whole week for the next cron. Returns false on an unparseable cron.
export function cronDueThisIsoWeek(cron: string, nowMs: number): boolean {
  try {
    const expr = CronExpressionParser.parse(cron, { currentDate: new Date(nowMs) })
    const prevFire = expr.prev().getTime()
    return isoWeek(new Date(prevFire)) === isoWeek(new Date(nowMs))
  } catch {
    return false
  }
}
