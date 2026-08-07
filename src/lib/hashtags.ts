/**
 * Hashtag client utilities.
 * Per the design notes G7: tags are normalized as lowercase, no leading #,
 * alphanumeric + underscore only.
 */

const TAG_RE = /^[a-z0-9_]+$/

export function normalizeTag(input: string): string {
  return String(input).trim().replace(/^#+/, '').toLowerCase()
}

export function isValidTag(t: string): boolean {
  if (!t) return false
  if (t.length > 60) return false
  return TAG_RE.test(t)
}

/** Format a tag for display: '#yourbrand'. */
export function displayTag(t: string): string {
  return '#' + t
}
