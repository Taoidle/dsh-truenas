/**
 * Text rendering helpers for tool results.
 *
 * Tool output is what the model reads, so it is rendered as compact plain text:
 * one aligned table per collection, one key/value block per object, and JSON
 * only for the generic escape-hatch call.
 */

const DAY = 24 * 60 * 60 * 1000

export function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']
  const exponent = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1)
  const scaled = bytes / 1024 ** exponent
  const digits = scaled >= 100 || exponent === 0 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(digits)} ${units[exponent]}`
}

export function formatDuration(seconds) {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total < 0) return '—'
  if (total < 60) return `${Math.round(total)}s`
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const parts = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes && !days) parts.push(`${minutes}m`)
  if (!parts.length) parts.push(`${Math.round(total)}s`)
  return parts.join(' ')
}

export function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const diff = Date.now() - date.getTime()
  if (diff >= 0 && diff < DAY) {
    if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
    return `${Math.round(diff / 3_600_000)}h ago`
  }
  const iso = date.toISOString()
  return iso.slice(0, 16).replace('T', ' ')
}

export function truncate(value, max = 120) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function cell(value, formatter) {
  if (value === undefined || value === null || value === '') return '—'
  return formatter ? formatter(value) : String(value)
}

/**
 * Render an aligned table.
 * columns: [{ key, header, format? }]
 */
export function table(rows, columns) {
  if (!rows || !rows.length) return '(none)'
  const columnsWithIndex = columns.map((column) => ({ ...column, label: column.header || column.key }))
  const body = rows.map((row) => columnsWithIndex.map((column) => cell(row[column.key], column.format)))
  const widths = columnsWithIndex.map((column, index) =>
    Math.max(column.label.length, ...body.map((line) => String(line[index]).length)),
  )
  const line = (values) =>
    values
      .map((value, index) => String(value).padEnd(widths[index]))
      .join('  ')
      .replace(/\s+$/, '')
  const output = [line(columnsWithIndex.map((column) => column.label))]
  output.push(widths.map((width) => '─'.repeat(width)).join('  '))
  for (const row of body) output.push(line(row))
  return output.join('\n')
}

/** Render `label: value` lines, skipping undefined entries. */
export function keyValues(entries) {
  const lines = []
  for (const [label, value] of entries) {
    if (value === undefined || value === null || value === '') continue
    lines.push(`${label}: ${value}`)
  }
  return lines.join('\n')
}

export function bulletList(items, formatter = String) {
  if (!items || !items.length) return '(none)'
  return items.map((item) => `- ${formatter(item)}`).join('\n')
}

export function jsonBlock(value, maxChars = 12000) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  if (text === undefined) text = String(value)
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}\n… truncated (${text.length - maxChars} more characters)`
  }
  return text
}

/**
 * Render a load-average triple. TrueNAS reports `[1, 5, 15]` as numbers, but
 * older payloads (and some fixtures) wrap them in a single keyed object, so
 * both shapes are accepted.
 */
export function formatLoadAverage(value) {
  let numbers
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] && typeof value[0] === 'object') {
      numbers = ['1', '5', '15'].map((key) => Number(value[0][key]))
    } else {
      numbers = value.map((item) => (item && typeof item === 'object' ? Number(item.value ?? item.load) : Number(item)))
    }
  } else if (value && typeof value === 'object') {
    numbers = ['1', '5', '15'].map((key) => Number(value[key]))
  }
  if (!numbers || !numbers.length || numbers.some((item) => !Number.isFinite(item))) return undefined
  return numbers.map((item) => item.toFixed(2)).join(' / ')
}

/** A short progress description for a job object. */
export function jobLine(job) {
  const percent = job?.progress?.percent
  const description = job?.progress?.description
  const progress = Number.isFinite(percent) ? `${percent}%` : ''
  return [job?.state, progress, description].filter(Boolean).join(' · ')
}

export function errorText(error) {
  if (!error) return 'Unknown error'
  const message = error.message || String(error)
  if (message === '[object Object]') return jsonBlock(error)
  return message
}
