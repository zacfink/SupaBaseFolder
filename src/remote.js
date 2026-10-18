const { createClient } = require('@supabase/supabase-js')

const PAGE = 1000
const PARALLEL = 6

// Every row, PAGE at a time, PARALLEL pages in flight. count is a hint taken just before: rows
// added since then show up in the full last page and are fetched one page at a time after it.
async function fetchPages(getPage, count) {
  const pages = []
  let next = 0
  const worker = async () => { for (let i; (i = next++) * PAGE < count;) pages[i] = await getPage(i * PAGE, i * PAGE + PAGE - 1) }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  for (let from = pages.length * PAGE; !pages.length || pages.at(-1).length === PAGE; from += PAGE) pages.push(await getPage(from, from + PAGE - 1))
  const seen = new Set()
  return pages.flat().filter(r => !seen.has(r.id) && seen.add(r.id)) // a row shifting pages mid-fetch would show up twice
}
// Legacy keys are JWTs and also go in Authorization; new sb_secret_ keys only go in apikey.
const headers = key => (key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key })

// Tables and column types from PostgREST's OpenAPI description. Needs the service_role / secret key.
async function fetchSchema(url, key) {
  const res = await fetch(`${url}/rest/v1/`, { headers: headers(key) })
  if (!res.ok) {
    let { message } = await res.json().catch(() => ({}))
    if (message === 'Invalid API key') message += ' (use the secret key from this same project, copied with the copy icon)'
    throw new Error(`Supabase answered ${res.status} ${res.statusText}${message ? `: ${message}` : ''}`)
  }
  const { definitions = {} } = await res.json()
  return Object.fromEntries(Object.entries(definitions).map(([table, d]) => [table, { columns: d.properties ?? {}, required: d.required ?? [] }]))
}

function connect(url, key) {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const check = ({ data, error, status }) => {
    if (error && status === 0) throw new TypeError(error.message) // never reached Supabase (offline, DNS): not a rejection
    if (error) throw new Error(error.message)
    return data
  }
  return {
    async fetchAll(table) {
      const { count, error, status } = await db.from(table).select('*', { count: 'exact', head: true })
      check({ data: null, error, status })
      return fetchPages(async (from, to) => check(await db.from(table).select('*').order('id').range(from, to)), count ?? 0)
    },
    upsert: async (table, row) => check(await db.from(table).upsert(row).select().single()),
    remove: async (table, id) => { check(await db.from(table).delete().eq('id', id)) },
    subscribe: onTable => db.channel('backend-sync').on('postgres_changes', { event: '*', schema: 'public' }, p => onTable(p.table)).subscribe(),
    close: () => db.removeAllChannels(),
  }
}

module.exports = { fetchSchema, connect, fetchPages, PAGE }
