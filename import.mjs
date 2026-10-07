import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { PGlite } from '@electric-sql/pglite'

const clean = (s) => String(s ?? '').replace(/[​\s]+/g, ' ').trim()
const LINE = /^(\d+)\.\s*([^|]+?)\s*\|\s*BIB\s*(\d+)\s*\|\s*(\S+)\s+(.+?)\s*\|\s*(.+?)$/

const wb = XLSX.read(readFileSync('เลขพัสดุ.xlsx'))
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1)

// ลบเฉพาะตารางพัสดุ ไม่ลบทั้ง pgdata — ตาราง visit ของ server.mjs ต้องอยู่ต่อ
const db = new PGlite('pgdata')
await db.exec('DROP TABLE IF EXISTS item, parcel')
await db.exec(readFileSync('schema.sql', 'utf8'))

let items = 0
await db.transaction(async (tx) => {
  for (const [name, phone, address, list, ems, count, sortKey] of rows) {
    if (!ems) continue
    await tx.query('INSERT INTO parcel VALUES ($1,$2,$3,$4,$5,$6)',
      [clean(ems), clean(name), clean(phone), clean(address), count, sortKey])
    for (const raw of String(list).split('\n')) {
      const line = clean(raw)
      if (!line) continue
      const m = line.match(LINE)
      if (!m) throw new Error(`parse fail ${ems}: ${line}`)
      await tx.query('INSERT INTO item VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [+m[3], clean(ems), +m[1], m[2], m[4], clean(m[5]), m[6]])
      items++
    }
  }
})

const { rows: [c] } = await db.query('SELECT (SELECT count(*) FROM parcel)::int p, (SELECT count(*) FROM item)::int i')
assert.equal(c.p, rows.filter((r) => r[4]).length)
assert.equal(c.i, items)
console.log(`imported ${c.p} parcels, ${c.i} items`)
await db.close()
