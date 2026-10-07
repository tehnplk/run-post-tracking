import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

try { process.loadEnvFile() } catch {} // .env: TH_POST_TOKEN = Token Key จาก track.thailandpost.co.th → สำหรับนักพัฒนา

const db = new PGlite('pgdata')
// แยกจาก schema.sql เพื่อให้ import ใหม่ไม่ล้างยอดผู้เข้าชม/สถานะที่เช็คแล้ว
await db.exec(`CREATE TABLE IF NOT EXISTS visit (key text NOT NULL, at timestamptz NOT NULL DEFAULT now());
               CREATE INDEX IF NOT EXISTS visit_key_at_idx ON visit (key, at);
               CREATE TABLE IF NOT EXISTS track_cache (ems text PRIMARY KEY, events jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now())`)

// Thailand Post Track API — โควตา 1,000 "เลข"/วัน (ไม่ใช่ครั้ง) จึงเช็คเฉพาะเลขที่ user กด, จำผล 1 ชม.,
// สถานะ 501 นำจ่ายสำเร็จ / 901 โอนเงินแล้ว = จบ ไม่เช็คอีก
const THPOST = process.env.THPOST_API ?? 'https://trackapi.thailandpost.co.th/post/api/v1' // override ไว้เทสต์กับ API ปลอม
const FINAL = new Set(['501', '901'])
const FRESH_MS = 60 * 60 * 1000
// โควตาหมด → ไม่ถามไปรษณีย์อีกจนข้ามวัน (เวลาไทย)
const bkkDate = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
let quotaFullOn = null
let apiToken = null // { token, expire } — token อายุ 1 เดือน
const thpost = async (path, auth, body) => {
  const r = await fetch(THPOST + path, {
    method: 'POST',
    headers: { Authorization: 'Token ' + auth, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!r.ok) throw Object.assign(new Error(`thpost ${path} HTTP ${r.status}`), { status: r.status })
  return r.json()
}
const getToken = async () => {
  if (apiToken && apiToken.expire > Date.now() + 24 * 3600 * 1000) return apiToken.token
  const key = process.env.TH_POST_TOKEN?.trim()
  if (!key) throw new Error('TH_POST_TOKEN not set')
  const j = await thpost('/authenticate/token', key)
  apiToken = { token: j.token, expire: Date.parse(j.expire.replace(' ', 'T')) }
  return j.token
}
const fetchEvents = async (ems, retry = true) => {
  try {
    const j = await thpost('/track', await getToken(), { status: 'all', language: 'TH', barcode: [ems] })
    // โควตาหมด: HTTP 200 + { status: false, message: "blocked, your request over quota!!" }
    if (!j.status) throw Object.assign(new Error('thpost: ' + j.message), { quota: /quota/i.test(j.message) })
    const tc = j.response.track_count
    if (tc && tc.count_number >= tc.track_count_limit) quotaFullOn = bkkDate() // เลขนี้คือตัวสุดท้ายของวัน
    // ไม่เก็บ/ไม่ส่ง receiver_name, signature, เบอร์เจ้าหน้าที่ — ค้นชื่อคนอื่นได้
    return (j.response.items[ems] ?? []).map((e) => ({
      status: e.status, description: e.status_description, date: e.status_date, detail: e.statusDetail, location: e.location,
    }))
  } catch (err) {
    if (err.status === 401 && retry) { apiToken = null; return fetchEvents(ems, false) } // Token Key ถูกสร้างใหม่
    throw err
  }
}
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

app.get('/api/track/:ems', async (req, res) => {
  // เฉพาะเลขในรายการของเรา — กันคนนอกใช้โควตาเช็คเลขอะไรก็ได้
  const { rows: [p] } = await db.query(
    'SELECT c.events, c.checked_at FROM parcel p LEFT JOIN track_cache c USING (ems) WHERE p.ems = $1',
    [req.params.ems]
  )
  if (!p) return res.status(404).json({ error: 'ไม่พบเลขพัสดุนี้ในรายการ' })
  const done = p.events?.some((e) => FINAL.has(e.status))
  if (done || (p.checked_at && Date.now() - p.checked_at < FRESH_MS)) return res.json({ events: p.events, checked_at: p.checked_at })
  if (quotaFullOn === bkkDate()) return res.json({ events: p.events ?? null, checked_at: p.checked_at ?? null, quota: true })
  try {
    const events = await fetchEvents(req.params.ems)
    const { rows: [c] } = await db.query(
      `INSERT INTO track_cache (ems, events) VALUES ($1, $2::jsonb)
       ON CONFLICT (ems) DO UPDATE SET events = EXCLUDED.events, checked_at = now() RETURNING checked_at`,
      [req.params.ems, JSON.stringify(events)]
    )
    res.json({ events, checked_at: c.checked_at })
  } catch (err) {
    console.error('track', req.params.ems, err.message)
    if (err.quota) quotaFullOn = bkkDate()
    res.json({ events: p.events ?? null, checked_at: p.checked_at ?? null, ...(err.quota ? { quota: true } : { stale: true }) }) // ใช้ผลเก่า (ถ้ามี)
  }
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
  button{font-size:18px;padding:0 20px;min-height:48px;border:0;border-radius:8px;background:#0b7a4b;color:#fff;cursor:pointer}
  table{width:100%;border-collapse:collapse;margin-top:16px} th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}
  tbody{border-top:2px solid #0b7a4b} td{vertical-align:top} td.name{font-weight:600}
  td.items{white-space:pre-line;font-size:15px} a{color:#06c} #msg{margin-top:16px;color:#666}
  td.ems button{font:600 16px monospace;min-height:44px;padding:0 12px;background:#fff;color:#0b7a4b;border:1px solid #0b7a4b;border-radius:8px}
  td.ems button::after{content:' ›'}
  dialog{width:min(520px,calc(100vw - 32px));border:0;border-radius:12px;padding:0;box-shadow:0 10px 40px rgba(0,0,0,.3)}
  dialog::backdrop{background:rgba(0,0,0,.45)} dialog:focus{outline:none}
  .dh{display:flex;justify-content:space-between;align-items:center;padding:4px 4px 4px 16px;background:#0b7a4b;color:#fff;font:600 17px monospace}
  .dh button{background:none;font-size:22px;padding:0 14px} #trk-x{margin-left:auto}
  #trk-copy{display:grid;place-items:center;padding:0 10px} #trk-copy .i-check,#trk-copy.done .i-copy{display:none} #trk-copy.done .i-check{display:block}
  #trk-body{padding:16px;max-height:60vh;overflow:auto} #trk-body p{margin:0;color:#555}
  #trk-body p.warn{margin-bottom:12px;padding:10px 12px;background:#fff7e6;border:1px solid #f0c36d;border-radius:8px;color:#6b4300}
  ol.tl{list-style:none;margin:0;padding:0}
  ol.tl li{position:relative;border-left:2px solid #cfe3d7;padding:0 0 16px 18px;margin-left:6px}
  ol.tl li::before{content:'';position:absolute;left:-7px;top:3px;width:12px;height:12px;border-radius:50%;background:#cfe3d7}
  ol.tl li:first-child::before{background:#0b7a4b} ol.tl li:last-child{border-color:transparent}
  ol.tl b{display:block} ol.tl small{display:block;color:#666;font-size:13px}
  .df{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid #eee;font-size:13px;color:#888}
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
    td.ems{padding-bottom:12px} td.ems button{display:block;width:100%;min-height:48px}
  }
</style></head><body>
<header><div><b>สำนักงานสาธารณสุขจังหวัดพิษณุโลก</b><span>รายการจัดส่งพัสดุ เดิน วิ่ง ปั่น ป้องกันอัมพาต ครั้งที่ 12</span></div></header>
<main>
<form id="f"><input id="q" type="search" enterkeyhint="search" aria-label="ชื่อ หรือ ชื่อ นามสกุล" placeholder="ชื่อ หรือ ชื่อ นามสกุล" autofocus required minlength="2"><button>ค้นหา</button></form>
<div id="msg"></div>
<table id="t" hidden><thead><tr><th>ชื่อ-สกุล</th><th>รายการของ</th><th>เลข EMS</th></tr></thead></table>
</main>
<dialog id="trk" aria-labelledby="trk-h" tabindex="-1">
  <div class="dh"><span id="trk-h"></span><button id="trk-copy" aria-label="คัดลอกเลข EMS" title="คัดลอกเลข EMS"><!-- lucide copy (ISC) --><svg class="i-copy" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><!-- lucide check (ISC) --><svg class="i-check" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></button><button id="trk-x" aria-label="ปิด">✕</button></div>
  <div id="trk-body"></div>
  <div class="df"><span id="trk-at"></span><a id="trk-web" target="_blank" rel="noopener">ดูบนเว็บไปรษณีย์ไทย ↗</a></div>
</dialog>
<footer id="visits">ผู้เข้าชมวันนี้ ${v.today.toLocaleString()} · ทั้งหมด ${v.total.toLocaleString()}</footer>
<script>
const clearResults = () => { for (const b of [...t.tBodies]) b.remove(); t.hidden = true; msg.textContent = '' }
q.oninput = () => { if (!q.value) clearResults() } // ปุ่ม ✕ ของช่อง search / ลบจนว่าง
f.onsubmit = async (e) => {
  e.preventDefault()
  const r = await fetch('/api/search?q=' + encodeURIComponent(q.value))
  const data = await r.json()
  clearResults()
  if (!q.value) return // กด ✕ ระหว่างรอผล
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
      const b = document.createElement('button')
      b.dataset.ems = ems; b.textContent = ems; b.setAttribute('aria-haspopup', 'dialog')
      cell.append(b)
    }
  }
  t.hidden = !data.length
}

// modal สถานะพัสดุ — ข้อมูลจาก /api/track (เซิร์ฟเวอร์ถาม API ไปรษณีย์ให้ + จำผล)
t.onclick = (e) => { const b = e.target.closest('button[data-ems]'); if (b) showTrack(b.dataset.ems) }
document.getElementById('trk-x').onclick = () => trk.close()
trk.onclick = (e) => { if (e.target === trk) trk.close() } // กดพื้นหลังปิด
const copyBtn = document.getElementById('trk-copy')
copyBtn.onclick = async () => {
  const ems = document.getElementById('trk-h').textContent
  try { await navigator.clipboard.writeText(ems) } catch {
    // LINE in-app browser บางรุ่นไม่ให้ใช้ Clipboard API — ใส่ textarea ใน dialog (นอก dialog เป็น inert)
    const ta = document.createElement('textarea'); ta.value = ems; trk.append(ta); ta.select()
    document.execCommand('copy'); ta.remove()
  }
  copyBtn.classList.add('done'); copyBtn.setAttribute('aria-label', 'คัดลอกแล้ว')
  setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.setAttribute('aria-label', 'คัดลอกเลข EMS') }, 1500)
}
const say = (text) => { const p = document.createElement('p'); p.textContent = text; return p }
const fmt = (d) => new Date(d).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' })
async function showTrack(ems) {
  const body = document.getElementById('trk-body'), at = document.getElementById('trk-at')
  document.getElementById('trk-h').textContent = ems
  // openExternalBrowser=1: LINE in-app browser เปิดใน Safari/Chrome แทน; browser อื่นไม่สนพารามิเตอร์นี้
  document.getElementById('trk-web').href = 'https://track.thailandpost.co.th/?trackNumber=' + ems + '&openExternalBrowser=1'
  body.replaceChildren(say('กำลังตรวจสอบสถานะ…')); at.textContent = ''
  trk.showModal()
  trk.focus() // showModal จะโฟกัสปุ่มแรก (copy) — ให้โฟกัสที่ตัว modal แทน, Tab ยังไปปุ่มต่างๆ ได้
  let d
  try { d = await (await fetch('/api/track/' + ems)).json() } catch { d = { events: null, stale: true } }
  if (document.getElementById('trk-h').textContent !== ems) return // ผู้ใช้เปิดเลขอื่นไปแล้ว
  if (d.error) return body.replaceChildren(say(d.error))
  const parts = []
  if (d.quota) { // โควตา API ไปรษณีย์ของวันนี้หมด
    const w = say('วันนี้ตรวจสอบสถานะครบโควตาแล้ว กรุณากดลิงก์ด้านล่าง "ดูบนเว็บไปรษณีย์ไทย"'); w.className = 'warn'; parts.push(w)
  }
  if (!d.events) { if (!d.quota) parts.push(say('ตรวจสอบสถานะไม่ได้ในขณะนี้ ลองใหม่ภายหลัง หรือดูบนเว็บไปรษณีย์ไทย')) }
  else if (!d.events.length) parts.push(say('ยังไม่มีข้อมูลในระบบไปรษณีย์ — พัสดุอาจยังไม่ได้ฝากส่ง'))
  else {
    const ol = document.createElement('ol'); ol.className = 'tl'
    for (const ev of [...d.events].reverse()) { // ล่าสุดอยู่บน
      const li = document.createElement('li'), b = document.createElement('b'), s = document.createElement('small')
      b.textContent = ev.description
      s.textContent = ev.date.slice(0, 16) + ' · ' + (ev.detail || ev.location || '')
      li.append(b, s); ol.append(li)
    }
    parts.push(ol)
  }
  body.replaceChildren(...parts)
  at.textContent = d.checked_at ? 'ตรวจสอบเมื่อ ' + fmt(d.checked_at) + (d.stale || d.quota ? ' (ข้อมูลเก่า)' : '') : ''
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
