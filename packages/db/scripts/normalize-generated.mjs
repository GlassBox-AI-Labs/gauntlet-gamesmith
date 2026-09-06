import { readFileSync, writeFileSync } from 'node:fs'
const path = process.argv[2]
if (!['supabase/schema.sql', 'types/supabase.ts'].includes(path)) {
  throw new Error('Expected a database-generated file')
}
writeFileSync(path, `${readFileSync(path, 'utf8').trimEnd()}\n`)
