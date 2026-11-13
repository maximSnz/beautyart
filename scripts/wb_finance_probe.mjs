// Проба финансового отчёта WB (13.11.2026; этап 1 → карты Шухарта WB: сначала маржа, решение владельца):
// «Отчёт о реализации» — statistics-api /api/v5/supplier/reportDetailByPeriod (строка = операция: продажа, возврат, логистика,
// хранение, штраф…; постранично по rrd_id, 1 запрос в минуту). Задача пробы — понять состав полей, типы операций, за какие
// дни есть строки (еженедельный и ежедневный отчёт), есть ли srid / chrt_id для связи с wb_orders и размером.
// Только чтение из WB, в базу не пишет. Репозиторий публичный — в лог: поля, типы операций и число строк, даты;
// суммы по операциям — только владельцу в Telegram (если заданы TELEGRAM_*).
const T = process.env.WB_API_TOKEN;
if (!T) throw new Error('нет секрета WB_API_TOKEN');
const FROM = process.env.FROM || '2026-10-27', TO = process.env.TO || '2026-11-09';
const PERIODS = (process.env.PERIODS || 'weekly,daily').split(',').map(s => s.trim()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MONEY = ['retail_price', 'retail_amount', 'retail_price_withdisc_rub', 'ppvz_for_pay', 'ppvz_sales_commission', 'ppvz_vw', 'ppvz_vw_nds',
  'ppvz_reward', 'acquiring_fee', 'delivery_rub', 'return_amount', 'storage_fee', 'penalty', 'additional_payment', 'deduction', 'acceptance',
  'rebill_logistic_cost', 'cashback_amount', 'cashback_discount'];

async function page(period, rrdid) {
  const url = `https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod?dateFrom=${FROM}&dateTo=${TO}&limit=100000&rrdid=${rrdid}&period=${period}`;
  for (let a = 1; a <= 6; a++) {
    const r = await fetch(url, { headers: { Authorization: T } });
    if (r.status === 429) { console.log(`  429 — жду ${60 * a} с`); await sleep(60000 * a); continue; }
    if (r.status === 204) return [];
    const text = await r.text();
    if (r.status !== 200) throw new Error(`${period}: HTTP ${r.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text); return Array.isArray(j) ? j : [];
  }
  throw new Error(`${period}: 429 после повторов`);
}

const tg = [];
for (const period of PERIODS) {
  console.log(`\n=== period=${period}, ${FROM} … ${TO} ===`);
  let rows = [], rrd = 0;
  for (let i = 0; i < 50; i++) {
    const p = await page(period, rrd);
    console.log(`  страница ${i + 1}: строк ${p.length}`);
    if (!p.length) break;
    rows = rows.concat(p); rrd = p[p.length - 1].rrd_id;
    await sleep(61000);
  }
  if (!rows.length) { console.log('  строк нет'); continue; }
  const fields = {}; rows.forEach(r => Object.entries(r).forEach(([k, v]) => { (fields[k] = fields[k] || new Set()).add(v === null ? 'null' : typeof v); }));
  console.log(`  всего строк: ${rows.length}; поля (${Object.keys(fields).length}):`);
  console.log('  ' + Object.entries(fields).map(([k, t]) => `${k}:${[...t].join('|')}`).join(', '));
  const cnt = (f) => { const m = {}; rows.forEach(r => { const k = r[f] ?? '—'; m[k] = (m[k] || 0) + 1; }); return m; };
  const show = (f) => console.log(`  ${f}: ` + Object.entries(cnt(f)).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} — ${n}`).join('; '));
  ['supplier_oper_name', 'doc_type_name', 'bonus_type_name', 'office_name', 'site_country', 'srv_dbs', 'is_legal_entity'].forEach(f => { if (f in fields) show(f); });
  const rng = f => { const v = rows.map(r => r[f]).filter(Boolean).map(s => String(s).slice(0, 10)).sort(); return v.length ? `${v[0]} … ${v[v.length - 1]}` : '—'; };
  ['rr_dt', 'sale_dt', 'order_dt', 'date_from', 'date_to', 'create_dt'].forEach(f => { if (f in fields) console.log(`  ${f}: ${rng(f)}`); });
  const reps = cnt('realizationreport_id'); console.log(`  отчётов (realizationreport_id): ${Object.keys(reps).length}`);
  const has = f => rows.filter(r => r[f] !== undefined && r[f] !== null && r[f] !== '' && r[f] !== 0).length;
  ['srid', 'chrt_id', 'nm_id', 'barcode', 'sa_name', 'ts_name'].forEach(f => console.log(`  ${f}: заполнено в ${(has(f) / rows.length * 100).toFixed(1)}% строк`));
  // суммы по операциям — в Telegram
  const byOp = {};
  rows.forEach(r => { const k = r.supplier_oper_name || '—'; const o = byOp[k] = byOp[k] || { n: 0, qty: 0 }; o.n++; o.qty += Number(r.quantity) || 0;
    MONEY.forEach(m => { if (typeof r[m] === 'number') o[m] = (o[m] || 0) + r[m]; }); });
  tg.push(`WB отчёт о реализации, ${period}, ${FROM}…${TO}: строк ${rows.length}`);
  Object.entries(byOp).sort((a, b) => b[1].n - a[1].n).forEach(([k, o]) => {
    const parts = MONEY.filter(m => o[m]).map(m => `${m} ${Math.round(o[m]).toLocaleString('ru-RU')}`);
    tg.push(`• ${k}: строк ${o.n}, шт ${o.qty}; ${parts.join(', ')}`);
  });
  const tot = {}; MONEY.forEach(m => tot[m] = rows.reduce((s, r) => s + (typeof r[m] === 'number' ? r[m] : 0), 0));
  tg.push('Итого: ' + MONEY.filter(m => tot[m]).map(m => `${m} ${Math.round(tot[m]).toLocaleString('ru-RU')}`).join(', '));
}

if (tg.length && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  let text = tg.join('\n');
  while (text.length) {
    const chunk = text.slice(0, 3900); text = text.slice(3900);
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: chunk, disable_web_page_preview: true }) });
    console.log(`Telegram: HTTP ${r.status}`);
  }
} else console.log('\nTelegram не задан — суммы не отправлены');
