import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz'
import type { PaymentCycle } from './types'

/**
 * All cycle math is done in America/New_York. This module is the single
 * source of truth for cycle id format, boundaries, and current/upcoming logic.
 *
 * Cycle id format:  'YYYY-M-H'   (M unpadded, H = 1 for days 1-15, 2 for 16-EOM)
 * Cycle A (H=1) = [day 1 00:00 ET, day 16 00:00 ET) of month M; pays at 6 PM ET on EOM
 * Cycle B (H=2) = [day 16 00:00 ET, 1st of next month 00:00 ET);  pays at 6 PM ET on the 15th of next month
 *
 * Round 4 R3: NO em-dashes/en-dashes anywhere in returned strings.
 */

export const ET_TZ = 'America/New_York'

/** Format an ISO timestamp (any TZ) as a YYYY-MM-DD date string in ET. */
export function dateInET(iso: string | Date): string {
  return formatInTimeZone(typeof iso === 'string' ? new Date(iso) : iso, ET_TZ, 'yyyy-MM-dd')
}

/** Decompose an ISO timestamp into ET components. */
export function partsInET(iso: string | Date) {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const year = parseInt(formatInTimeZone(d, ET_TZ, 'yyyy'), 10)
  const month = parseInt(formatInTimeZone(d, ET_TZ, 'M'), 10)
  const day = parseInt(formatInTimeZone(d, ET_TZ, 'd'), 10)
  return { year, month, day }
}

/**
 * Determine the cycle id for a given ISO timestamp using ET cutoffs.
 * E.g. a video posted at 23:59 ET on the 15th -> 'Y-M-1'; 00:01 ET on 16th -> 'Y-M-2'.
 */
export function cycleIdForDate(iso: string | Date): string {
  const { year, month, day } = partsInET(iso)
  const half = day <= 15 ? 1 : 2
  return `${year}-${month}-${half}`
}

/** Build a synthetic cycle object for display-only purposes (no DB call). */
export function buildSyntheticCycle(year: number, month: number, half: 1 | 2): PaymentCycle {
  // Construct boundaries via fromZonedTime so the wall-clock math is in ET.
  const startWall = new Date(Date.UTC(year, month - 1, half === 1 ? 1 : 16, 0, 0, 0))
  const endWall = (() => {
    if (half === 1) {
      // [day1 00:00 ET, day16 00:00 ET)
      return new Date(Date.UTC(year, month - 1, 16, 0, 0, 0))
    }
    // [day16 00:00 ET, day1 of next month 00:00 ET)
    return new Date(Date.UTC(year, month, 1, 0, 0, 0))
  })()
  const start = fromZonedTime(startWall, ET_TZ)
  const end = fromZonedTime(endWall, ET_TZ)

  // Pay at 6 PM ET on EOM (A) or 15th of next month (B)
  const dueWall =
    half === 1
      ? new Date(Date.UTC(year, month, 0, 18, 0, 0)) // EOM at 18:00 wall ET
      : new Date(Date.UTC(year, month, 15, 18, 0, 0))
  const due = fromZonedTime(dueWall, ET_TZ)

  return {
    id: `${year}-${month}-${half}`,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    payment_due_at: due.toISOString(),
    snapshot_generated_at: null,
    marked_paid_at: null,
  }
}

/** Format a cycle as 'Apr 16 to Apr 30, 2026' (no dashes per R3). */
export function fmtCycle(cycle: PaymentCycle): string {
  const startStr = formatInTimeZone(new Date(cycle.period_start), ET_TZ, 'MMM d')
  // period_end is exclusive; display the inclusive end (subtract 1 day in ET).
  const endInclusive = new Date(new Date(cycle.period_end).getTime() - 24 * 60 * 60 * 1000)
  const endStr = formatInTimeZone(endInclusive, ET_TZ, 'MMM d, yyyy')
  return `${startStr} to ${endStr}`
}

/** Short form 'Apr 16 to 30, 2026' (no dashes per R3). */
export function fmtCycleShort(cycle: PaymentCycle): string {
  const startMonth = formatInTimeZone(new Date(cycle.period_start), ET_TZ, 'MMM')
  const startDay = formatInTimeZone(new Date(cycle.period_start), ET_TZ, 'd')
  const endInclusive = new Date(new Date(cycle.period_end).getTime() - 24 * 60 * 60 * 1000)
  const endMonth = formatInTimeZone(endInclusive, ET_TZ, 'MMM')
  const endDay = formatInTimeZone(endInclusive, ET_TZ, 'd')
  const year = formatInTimeZone(endInclusive, ET_TZ, 'yyyy')
  // If start and end share a month, omit the second month name.
  if (startMonth === endMonth) {
    return `${startMonth} ${startDay} to ${endDay}, ${year}`
  }
  return `${startMonth} ${startDay} to ${endMonth} ${endDay}, ${year}`
}

/**
 * Determine the display-cycle for the payment status bar (the design notes).
 * Returns { cycle, mode: 'current' | 'upcoming' }.
 *
 * Mode 'current' = "Current payment for X" (action required, mark paid button visible).
 * Mode 'upcoming' = "Upcoming payment cycle: X" (still maturing).
 *
 * Logic (ROUND 15 Flow B):
 *   - find the cycle whose [start, end) contains 'now' in ET.
 *   - among all PAST cycles (period_end <= now), pick the OLDEST unpaid one
 *     (smallest period_start where !marked_paid_at) -> show as 'current'.
 *     This ensures multi-cycle backlog surfaces in order: Apr 16-30 first,
 *     then May 1-15, then May 16-31, etc.
 *   - otherwise show the cycle containing 'now' as 'upcoming'.
 *
 * Pre-Round-15 behavior was to look ONLY at the immediately previous cycle;
 * if multiple past cycles were unpaid, the older ones were hidden. Now any
 * older unpaid past cycle takes priority over the just-prior one. After
 * admin clicks "Mark Paid" on Apr 16-30, dashboard auto-advances to May 1-15.
 */
export function getDisplayCycle(
  cycles: PaymentCycle[],
  now: Date = new Date(),
): { cycle: PaymentCycle; mode: 'current' | 'upcoming' } | null {
  if (cycles.length === 0) return null
  const sorted = [...cycles].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const nowMs = now.getTime()
  const currentIdx = sorted.findIndex((c) => {
    const s = new Date(c.period_start).getTime()
    const e = new Date(c.period_end).getTime()
    return nowMs >= s && nowMs < e
  })
  const current = currentIdx >= 0 ? sorted[currentIdx] : sorted[sorted.length - 1]

  // ROUND 15 Flow B: scan ALL past cycles for the oldest unpaid one.
  // A "past cycle" has period_end <= now (it has fully closed).
  const oldestUnpaidPast = sorted.find((c) => {
    const e = new Date(c.period_end).getTime()
    return e <= nowMs && !c.marked_paid_at
  })
  if (oldestUnpaidPast) {
    return { cycle: oldestUnpaidPast, mode: 'current' }
  }
  return { cycle: current, mode: 'upcoming' }
}

/**
 * Should we still refresh views for this video?
 *
 * Stop refreshing when:
 *   - 14+ days have elapsed since posting (day 16 onward), OR
 *   - the cycle has been marked paid (the worker also writes views_frozen=true)
 */
export function shouldRefreshViews(postedDate: string, cycleMarkedPaid: boolean): boolean {
  if (cycleMarkedPaid) return false
  const posted = new Date(postedDate + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const daysSince = Math.floor((today.getTime() - posted.getTime()) / 86_400_000)
  return daysSince < 15
}
