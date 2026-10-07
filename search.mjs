import { PGlite } from '@electric-sql/pglite'

const q = process.argv.slice(2).join(' ').replace(/[​\s]+/g, ' ').trim()
if (!q) throw new Error('usage: npm run search -- <ชื่อ>')

const db = new PGlite('pgdata')
// ไม่คืนเบอร์โทร/ที่อยู่ — ค้นด้วยชื่อคนอื่นได้ จึงคืนแค่ข้อมูลที่จำเป็นต่อการตามพัสดุ
const { rows } = await db.query(
  `SELECT i.full_name, i.bib, i.size, i.event, i.ems
     FROM item i
    WHERE i.full_name ILIKE '%' || $1 || '%'
    ORDER BY i.full_name, i.bib
    LIMIT 50`,
  [q.replace(/[\\%_]/g, '\\$&')]
)
console.table(rows)
await db.close()
