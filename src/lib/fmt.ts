import { formatInTimeZone } from 'date-fns-tz'
import { ET_TZ } from './cycles'

/**
 * Display formatters. Per the design notes R3 these MUST NOT contain em-dashes
 * or en-dashes. Hyphens in compound words like "cross-posted" are fine.
 */

/** Money: $1,234 (no decimals; round to nearest dollar). */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '$0'
  return '$' + Math.round(n).toLocaleString('en-US')
}

/** Compact views: 1.2M, 45.6K, 999 */
export function compactNum(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '0'
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '') + 'M'
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'K'
  }
  return String(Math.round(n))
}

/** Date as 'May 4, 2026' (in ET). */
export function fmtDate(iso: string | Date): string {
  if (!iso) return ''
  const d = typeof iso === 'string'
    ? (iso.length === 10 ? new Date(iso + 'T12:00:00Z') : new Date(iso))
    : iso
  return formatInTimeZone(d, ET_TZ, 'MMM d, yyyy')
}

/** Date+time as 'May 7, 2026, 3:14 PM ET' (per Round 4 F2). */
export function fmtDateTimeET(iso: string | Date): string {
  if (!iso) return ''
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return formatInTimeZone(d, ET_TZ, 'MMM d, yyyy, h:mm a') + ' ET'
}

/** Empty cell placeholder. Per R3, no em-dash; we use a bare space. */
export const EMPTY_CELL = ''

/** Cross-post denial message used in payout cells (Round 4 R1). */
export const NOT_CROSS_POSTED_MSG = '$0 (not cross posted on both IG & TT)'
