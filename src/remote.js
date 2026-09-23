const { createClient } = require('@supabase/supabase-js')

const PAGE = 1000
// Legacy keys are JWTs and also go in Authorization; new sb_secret_ keys only go in apikey.
const headers = key => (key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key })

// Tables and column types from PostgREST's OpenAPI description. Needs the service_role / secret key.
async function fetchSchema(url, key) {
  const res = await fetch(`${url}/rest/v1/`, { headers: headers(key) })
  if (!res.ok) throw new Error(`Supabase answered ${res.status} ${res.statusText}`)
  const { definitions = {} } = await res.json()
  return Object.fromEntries(Object.entries(definitions).map(([table, d]) => [table, { columns: d.properties ?? {}, required: d.required ?? [] }]))
}

function connect(url, key) {
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const check = ({ data, error }) => {
    if (error) throw new Error(error.message)
    return data
  }
  return {
    async fetchAll(table) {
      const rows = []
      for (let from = 0; ; from += PAGE) {
        const page = check(await db.from(table).select('*').order('id').range(from, from + PAGE - 1))
        rows.push(...page)
        if (page.length < PAGE) return rows
      }
    },
    upsert: async (table, row) => check(await db.from(table).upsert(row).select().single()),
    remove: async (table, id) => { check(await db.from(table).delete().eq('id', id)) },
    subscribe: onTable => db.channel('backend-sync').on('postgres_changes', { event: '*', schema: 'public' }, p => onTable(p.table)).subscribe(),
    close: () => db.removeAllChannels(),
  }
}

module.exports = { fetchSchema, connect }
