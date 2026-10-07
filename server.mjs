import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite('pgdata')
// แยกจาก schema.sql เพื่อให้ import ใหม่ไม่ล้างยอดผู้เข้าชม
await db.exec(`CREATE TABLE IF NOT EXISTS visit (key text NOT NULL, at timestamptz NOT NULL DEFAULT now());
               CREATE INDEX IF NOT EXISTS visit_key_at_idx ON visit (key, at)`)
const app = express()
app.set('trust proxy', 'loopback') // อยู่หลัง nginx บนเครื่องเดียวกัน → req.ip เป็น IP จริงของผู้ใช้
// เก็บแค่ hash(ip+UA) ไม่เก็บ IP ดิบ; salt สุ่มต่อการรัน → restart แล้วนับคนเดิมใหม่ได้ 1 ครั้ง
const SALT = randomBytes(16).toString('hex')
const DEDUPE = '30 minutes'

// ปิดท้ายนามสกุล: ยาว ≥4 ตัว → ** , สั้นกว่า → * — นับเป็น grapheme ("ธ์" = 1 ตัว)
// นามสกุล = ทุกอย่างหลังเว้นวรรคแรก (ข้อมูลดิบบางคนมีวรรคกลางนามสกุล เช่น "วิรัช กุล")
const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' })
const maskName = (full) => {
  const i = full.indexOf(' ')
  if (i < 0) return full
  const g = [...graphemes.segment(full.slice(i + 1))].map((s) => s.segment)
  const n = g.length <= 3 ? 1 : 2
  return full.slice(0, i + 1) + g.slice(0, -n).join('') + '*'.repeat(n)
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').replace(/[​\s]+/g, ' ').trim()
  if (q.length < 2) return res.status(400).json({ error: 'พิมพ์อย่างน้อย 2 ตัวอักษร' })
  // ไม่คืนเบอร์โทร/ที่อยู่ — ค้นด้วยชื่อคนอื่นได้ จึงคืนแค่ข้อมูลที่จำเป็นต่อการตามพัสดุ
  const { rows } = await db.query(
    `SELECT full_name, bib, size, event, ems
       FROM item
      WHERE full_name ILIKE '%' || $1 || '%'
      ORDER BY full_name, bib
      LIMIT 50`,
    [q.replace(/[\\%_]/g, '\\$&')]
  )
  // ไม่ส่งชื่อเต็มออกไป; group แยกคนที่ชื่อ mask แล้วบังเอิญซ้ำกัน
  const group = new Map()
  res.json(rows.map(({ full_name, ...r }) => {
    if (!group.has(full_name)) group.set(full_name, group.size)
    return { name: maskName(full_name), group: group.get(full_name), ...r }
  }))
})

app.get('/', async (req, res) => {
  // นับ 1 ครั้งต่อ ip+UA ต่อ 30 นาที — refresh รัวๆ ไม่เพิ่มยอด
  // ponytail: ไม่ได้กัน bot ที่สุ่ม UA ทุก request; ถ้าโดนจริงค่อยใส่ rate limit
  const key = createHash('sha256').update(SALT + req.ip + '|' + (req.get('user-agent') ?? '')).digest('hex')
  await db.query(
    `INSERT INTO visit (key) SELECT $1
      WHERE NOT EXISTS (SELECT 1 FROM visit WHERE key = $1 AND at > now() - $2::interval)`,
    [key, DEDUPE]
  )
  const { rows: [v] } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE (at AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date)::int AS today
       FROM visit`
  )
  res.type('html').send(`<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ค้นหาเลขพัสดุ</title><link rel="icon" href="data:,">
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#fff;color:#222}
  header{background:#0b7a4b;color:#fff} header div{max-width:760px;margin:0 auto;padding:14px 16px}
  header b{display:block;font-size:20px} header span{display:block;font-size:14px;opacity:.85;margin-top:2px}
  main{max-width:760px;margin:0 auto;padding:16px}
  form{display:flex;gap:8px} input{flex:1;min-width:0;font-size:18px;padding:0 12px;min-height:48px;border:1px solid #999;border-radius:8px}
  button{font-size:18px;padding:0 20px;min-height:48px;border:0;border-radius:8px;background:#0b7a4b;color:#fff}
  table{width:100%;border-collapse:collapse;margin-top:16px} th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}
  tbody{border-top:2px solid #0b7a4b} td{vertical-align:top} td.name{font-weight:600}
  td.items{white-space:pre-line;font-size:15px} td.ems{font-family:monospace;font-size:16px} a{color:#06c} #msg{margin-top:16px;color:#666}
  footer{max-width:760px;margin:24px auto 0;padding:16px;color:#888;font-size:13px;text-align:center;border-top:1px solid #eee}
  /* มือถือ: ตาราง → การ์ด 1 ใบต่อคน, ปุ่ม EMS เต็มความกว้างกดง่าย */
  @media (max-width:600px){
    header b{font-size:18px}
    thead{display:none} table,tbody,tr,td{display:block}
    tbody{border:1px solid #cfe3d7;border-top:4px solid #0b7a4b;border-radius:10px;margin-bottom:12px}
    td{border:0;padding:4px 14px}
    td.name{font-size:18px;padding-top:12px}
    tr.parcel+tr.parcel{border-top:1px dashed #cfe3d7;margin-top:6px;padding-top:6px}
    td.items::before{content:'รายการของ';display:block;font-size:12px;color:#666}
    td.ems{padding-bottom:12px}
    td.ems a{display:block;text-align:center;padding:12px;border:1px solid #0b7a4b;border-radius:8px;text-decoration:none;color:#0b7a4b;font-weight:600}
    td.ems a::after{content:' ↗'}
  }
</style></head><body>
<header><div><b>สำนักงานสาธารณสุขจังหวัดพิษณุโลก</b><span>รายการจัดส่งพัสดุ เดิน วิ่ง ปั่น ป้องกันอัมพาต ครั้งที่ 12</span></div></header>
<main>
<form id="f"><input id="q" type="search" enterkeyhint="search" aria-label="ชื่อ หรือ ชื่อ นามสกุล" placeholder="ชื่อ หรือ ชื่อ นามสกุล" autofocus required minlength="2"><button>ค้นหา</button></form>
<div id="msg"></div>
<table id="t" hidden><thead><tr><th>ชื่อ-สกุล</th><th>รายการของ</th><th>เลข EMS</th></tr></thead></table>
</main>
<footer id="visits">ผู้เข้าชมวันนี้ ${v.today.toLocaleString()} · ทั้งหมด ${v.total.toLocaleString()}</footer>
<script>
f.onsubmit = async (e) => {
  e.preventDefault()
  const r = await fetch('/api/search?q=' + encodeURIComponent(q.value))
  const data = await r.json()
  for (const b of [...t.tBodies]) b.remove()
  t.hidden = true
  if (!r.ok) return msg.textContent = data.error
  msg.textContent = data.length ? 'พบ ' + new Set(data.map((x) => x.ems)).size + ' รายการส่งของ' + (data.length === 50 ? ' (แสดง 50 แรก พิมพ์ให้ละเอียดขึ้น)' : '') : 'ไม่พบชื่อนี้'
  // 1 tbody ต่อชื่อ, 1 แถวต่อกล่อง (EMS), ชื่อ rowspan ครอบทุกกล่องของคนนั้น
  for (const items of Map.groupBy(data, (x) => x.group).values()) {
    const name = items[0].name
    const body = t.createTBody()
    const parcels = Map.groupBy(items, (x) => x.ems)
    for (const [ems, its] of parcels) {
      const tr = body.insertRow(); tr.className = 'parcel'
      if (!tr.sectionRowIndex) {
        const td = tr.insertCell(); td.className = 'name'; td.rowSpan = parcels.size; td.textContent = name
      }
      const td = tr.insertCell(); td.className = 'items'
      td.textContent = its.map((x) => 'BIB ' + x.bib + ' · ' + x.size + ' · ' + x.event).join('\\n')
      const cell = tr.insertCell(); cell.className = 'ems'
      const a = document.createElement('a')
      // openExternalBrowser=1: LINE in-app browser เปิดใน Safari/Chrome แทน; browser อื่นไม่สนพารามิเตอร์นี้
      a.href = 'https://track.thailandpost.co.th/?trackNumber=' + ems + '&openExternalBrowser=1'
      a.target = '_blank'; a.rel = 'noopener'; a.textContent = ems
      cell.append(a)
    }
  }
  t.hidden = !data.length
}
</script></body></html>`)
})

const port = process.env.PORT || 3001
const server = app.listen(port, (err) => {
  if (err) throw err
  console.log(`http://localhost:${port}`)
})

// pm2 restart/stop ส่ง SIGINT — ต้องปิด PGlite ให้เรียบร้อย ไม่งั้น pgdata เสียได้ (เจอจริงตอน kill -9)
// postmaster.pid ค้างอยู่เสมอแม้ close ถูก — ดูจาก log "pgdata closed" แทน
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    server.close(async () => {
      await db.close()
      console.log(`${sig}: pgdata closed`)
      process.exit(0)
    })
    server.closeAllConnections() // ไม่รอ keep-alive — pm2 จะ SIGKILL หลัง 1.6 วิ
  })
}
