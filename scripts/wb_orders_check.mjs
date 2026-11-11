// Разовая сверка заказов WB из трёх методов API (11.11.2026):
//  1) статистика supplier/orders — её грузит wb-daily-load;
//  2) воронка продаж /api/analytics/v3/sales-funnel/products — как «Воронка продаж» в кабинете;
//  3) лента заказов /api/analytics/v1/order-feed — как «Лента заказов» в кабинете (1 заказ = 1 единица товара).
// Повод: «Лента заказов» кабинета за 09–10.11 показала на 4–6% больше заказов, чем supplier/orders.
// Только чтение из WB, в базу не пишет. Репозиторий публичный — печатаем названия полей, отношения в % и число артикулов,
// без штук и рублей.
const T = process.env.WB_API_TOKEN;
if (!T) throw new Error('нет секрета WB_API_TOKEN');
const H = { Authorization: T, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = (process.env.DAYS || '2026-11-09,2026-11-10').split(',').map(s => s.trim()).filter(Boolean).sort();
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';

async function call(method, url, body) {
  for (let a = 1; a <= 6; a++) {
    const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(30000 * a); continue; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  }
  return { status: 429, json: null, text: '429 после повторов' };
}
// структура объекта: пути полей с типами (без значений)
function keys(v, p = '', out = []) {
  if (Array.isArray(v)) { if (v.length && typeof v[0] === 'object') keys(v[0], p + '[]', out); else out.push(`${p}[]`); }
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => keys(x, p ? `${p}.${k}` : k, out));
  else out.push(`${p}:${typeof v}`);
  return out;
}
// первое числовое поле, путь которого подходит под шаблон
function findNum(v, re, p = '') {
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) {
    const q = p ? `${p}.${k}` : k;
    if (typeof x === 'number' && re.test(q)) return { path: q, val: x };
    const r = findNum(x, re, q); if (r) return r;
  }
  return null;
}

// 1) статистика: заказы по дню date (Мск) и артикулу; строка = единица товара
const o = await call('GET', `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${shift(DAYS[0], -1)}`);
if (o.status !== 200) throw new Error(`supplier/orders -> HTTP ${o.status}: ${(o.text || '').slice(0, 300)}`);
const ST = {}, ST_ID = {};
for (const x of o.json || []) { const d = String(x.date).slice(0, 10); if (!DAYS.includes(d)) continue;
  (ST[d] = ST[d] || {})[x.nmId] = (ST[d][x.nmId] || 0) + 1; (ST_ID[d] = ST_ID[d] || new Set()).add(x.srid); }
const sum = m => Object.values(m || {}).reduce((s, v) => s + v, 0);

// 2) воронка: по каждому дню — все товары (limit 1000), число заказов на артикул
console.log('\n===== Воронка продаж (sales-funnel/products)');
const FN = {}; let shown = false;
for (const d of DAYS) {
  const r = await call('POST', 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products',
    { selectedPeriod: { start: d, end: d }, nmIds: [], limit: 1000, offset: 0 });
  if (r.status !== 200) { console.log(`  ${d}: HTTP ${r.status}: ${(r.text || '').slice(0, 300)}`); await sleep(21000); continue; }
  const ps = r.json?.data?.products || [];
  if (!shown && ps[0]) { console.log(`  поля товара: ${keys(ps[0]).join(', ')}`); shown = true; }
  const m = {}; let path = null;
  ps.forEach(p => { const nm = p.product?.nmId ?? p.nmId ?? p.product?.nmID; const f = findNum(p, /selected.*order(s)?Count$/i) || findNum(p, /order(s)?Count$/i);
    if (f) { path = f.path; if (f.val) m[nm] = (m[nm] || 0) + f.val; } });
  FN[d] = m;
  const s = ST[d] || {}, nm = new Set([...Object.keys(s), ...Object.keys(m)]); let eq = 0, more = 0, less = 0;
  nm.forEach(k => { const a = m[k] || 0, b = s[k] || 0; if (a > b) more++; else if (a < b) less++; else eq++; });
  console.log(`  ${d}: поле заказов «${path}»; товаров в ответе ${ps.length}; воронка ÷ статистика = ${pct(sum(m), sum(s))}; артикулов: совпало ${eq}, в воронке больше ${more}, меньше ${less}`);
  await sleep(21000);
}

// 3) лента заказов: период — по дате ТЕКУЩЕГО статуса, поэтому берём от первого дня до сейчас и отбираем по дате оформления
console.log('\n===== Лента заказов (order-feed)');
const FD = []; let snap = null, off = 0, fieldsShown = false;
for (let i = 0; i < 30; i++) {
  const body = { selectedPeriod: { start: `${DAYS[0]}T00:00:00.00000+03:00`, end: new Date().toISOString() }, pagination: { offset: off, limit: 1000, ...(snap ? { snapshotTime: snap } : {}) } };
  const r = await call('POST', 'https://seller-analytics-api.wildberries.ru/api/analytics/v1/order-feed', body);
  if (r.status !== 200) { console.log(`  HTTP ${r.status}: ${(r.text || '').slice(0, 300)}`); break; }
  const os = r.json?.data?.orders || []; snap = r.json?.data?.snapshotTime || snap;
  if (!fieldsShown && os[0]) { console.log(`  поля заказа: ${keys(os[0]).join(', ')}`); fieldsShown = true; }
  FD.push(...os); off += os.length;
  if (os.length < 1000) break;
  await sleep(61000); // лимит метода — 1 запрос в минуту
}
console.log(`  страниц прочитано: ${Math.ceil((off || 1) / 1000)}`);
if (FD.length) {
  const f0 = FD[0];
  const idKey = Object.keys(f0).find(k => /^(srid|rid|orderId|id)$/i.test(k)) || Object.keys(f0).find(k => /srid|id$/i.test(k));
  const dtKey = Object.keys(f0).find(k => /^(orderDate|createdAt|orderDt|date)$/i.test(k)) || Object.keys(f0).find(k => /order.*(date|dt|time)|created/i.test(k));
  const nmKey = Object.keys(f0).find(k => /^nm(Id|ID)$/.test(k));
  console.log(`  поля: ID «${idKey}», дата оформления «${dtKey}», артикул «${nmKey}»; пример формата даты: ${String(f0[dtKey]).replace(/\d/g, '9')}`);
  for (const d of DAYS) {
    // дата оформления → московский день
    const mine = FD.filter(x => { const v = x[dtKey]; if (!v) return false; const t = Date.parse(v); if (!isNaN(t) && /[zZ]|[+-]\d\d:?\d\d$/.test(v)) return new Date(t + 3 * 36e5).toISOString().slice(0, 10) === d; return String(v).slice(0, 10) === d; });
    const ids = new Set(mine.map(x => String(x[idKey]))), st = ST_ID[d] || new Set();
    const both = [...ids].filter(x => st.has(x)).length;
    console.log(`  ${d}: лента ÷ статистика = ${pct(ids.size, st.size)}; общих ID — ${pct(both, st.size)} от статистики; в ленте, но нет в статистике — ${pct(ids.size - both, st.size)}; в статистике, но нет в ленте — ${pct(st.size - both, st.size)}`);
    const miss = mine.filter(x => !st.has(String(x[idKey])));
    if (miss.length) { const by = (k) => { const c = {}; miss.forEach(x => { const v = String(x[k] ?? '—'); c[v] = (c[v] || 0) + 1; }); return Object.keys(c).join(' | '); };
      ['status', 'orderStatus', 'warehouseType', 'deliveryType', 'orderType', 'salesModel'].filter(k => k in f0).forEach(k => console.log(`     нет в статистике — ${k}: ${by(k)}`)); }
  }
}
console.log('\nДля сравнения: «Лента заказов» кабинета (файл 11.11) ÷ статистика — 09.11: 104,6%, 10.11: 106,3% (по московскому дню).');
