/** Date and time text. Pure: every function takes `now` and the locale. */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const safeLocale = (locale: string): string => {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0 ? locale : "en"
  } catch {
    return "en"
  }
}

/** "3 min ago", "2 h ago", "4 days ago". A time in the future reads "just now". */
export const relativeTime = (iso: string, now: number): string => {
  const age = now - Date.parse(iso)
  if (!Number.isFinite(age)) return ""
  if (age < MINUTE) return "just now"
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`
  const days = Math.floor(age / DAY)
  return days === 1 ? "1 day ago" : `${days} days ago`
}

/** "14:32" for today, "Nov 10, 14:32" for another day. */
export const absoluteTime = (iso: string, now: number, locale: string): string => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const loc = safeLocale(locale)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const time = new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit" }).format(date)
  if (sameDay) return `today ${time}`
  const sameYear = new Date(now).getFullYear() === date.getFullYear()
  const day = new Intl.DateTimeFormat(loc, sameYear ? { month: "short", day: "numeric" } : { dateStyle: "medium" }).format(
    date,
  )
  return `${day}, ${time}`
}

/** Absolute and relative together: "today 14:32 (3 min ago)". */
export const timeText = (iso: string, now: number, locale: string): string =>
  `${absoluteTime(iso, now, locale)} (${relativeTime(iso, now)})`

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Interval text for `refreshMinutes`. */
export const everyText = (minutes: number): string => {
  if (minutes % 60 === 0) {
    const hours = minutes / 60
    return hours === 1 ? "Every hour" : `Every ${hours} hours`
  }
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`
}
