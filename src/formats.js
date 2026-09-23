const fs = require('node:fs')
const XLSX = require('xlsx')

const isJson = ({ type, format }) => format === 'jsonb' || format === 'json' || type === 'array'

// Turn whatever a file holds into the value Supabase would return, so rows compare cleanly.
function coerceValue(v, col) {
  if (v === null || v === undefined || v === '') return null
  const { type, format = '' } = col
  if (isJson(col)) {
    if (typeof v !== 'string') return v
    try { return JSON.parse(v) } catch { throw new Error('is not valid JSON') }
  }
  if (type === 'integer' || type === 'number') {
    const n = Number(v)
    if (Number.isNaN(n)) throw new Error(`"${v}" is not a number`)
    return n
  }
  if (type === 'boolean') {
    if (typeof v === 'boolean') return v
    const s = String(v).trim().toLowerCase()
    if (s === 'true' || s === 'false') return s === 'true'
    throw new Error(`"${v}" is not true or false`)
  }
  if (format === 'timestamp with time zone') {
    const d = new Date(v)
    if (Number.isNaN(+d)) throw new Error(`"${v}" is not a date and time`)
    return d.toISOString()
  }
  if (v instanceof Date) {
    // Excel typed a date into a column with no time zone: keep the wall-clock time as written.
    const wall = new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString()
    return format === 'date' ? wall.slice(0, 10) : wall.slice(0, 19)
  }
  return String(v)
}

// firstRow is the row number people see for rows[0]: 2 in a sheet (row 1 is headers), 1 in JSON.
function coerceRows(rows, columns, firstRow = 1) {
  const warnings = new Set()
  const out = rows.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Row ${i + firstRow} is not an object`)
    for (const k of Object.keys(raw)) if (!Object.hasOwn(columns, k)) warnings.add(`Column "${k}" isn't in Supabase, so it's ignored`)
    return Object.fromEntries(Object.entries(columns).map(([name, col]) => {
      try { return [name, coerceValue(raw[name], col)] }
      catch (e) { throw new Error(`Row ${i + firstRow}, ${name}: ${e.message}`) }
    }))
  })
  return { rows: out, warnings: [...warnings] }
}

// Which columns actually appear in the raw file, before coercion fills the rest with null —
// so callers can tell "column has no value anywhere" from "column header/key is gone".
const keysOf = rows => new Set(rows.flatMap(r => (r && typeof r === 'object' && !Array.isArray(r)) ? Object.keys(r) : []))

function readTable(file, columns) {
  if (file.endsWith('.json')) {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(rows)) throw new Error('the file must be a JSON array of rows')
    return { ...coerceRows(rows, columns, 1), keys: keysOf(rows) }
  }
  const wb = XLSX.read(fs.readFileSync(file), { cellDates: true })
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null })
  return { ...coerceRows(raw, columns, 2), keys: keysOf(raw) }
}

// Written to a temp file and renamed, so a half-written file is never read.
function writeTable(file, rows, columns) {
  const names = Object.keys(columns)
  let data
  if (file.endsWith('.json')) {
    data = JSON.stringify(rows, null, 2) + '\n'
  } else {
    const cell = (v, col) => (v !== null && isJson(col) ? JSON.stringify(v) : v)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([names, ...rows.map(r => names.map(n => cell(r[n], columns[n])))]), 'Sheet1')
    data = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  }
  fs.writeFileSync(file + '.tmp', data)
  fs.renameSync(file + '.tmp', file)
}

module.exports = { coerceRows, readTable, writeTable }
