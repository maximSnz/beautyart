// Проба финансового отчёта WB (13.11.2026; этап 1 → карты Шухарта WB: сначала маржа, решение владельца):
// «Отчёт о реализации» — finance-api POST /api/finance/v1/sales-reports/detailed (старый statistics-api v5 reportDetailByPeriod
// 13.11.2026 отвечает 404; поля — camelCase, суммы — строками) (строка = операция: продажа, возврат, логистика,
// хранение, штраф…; постранично по rrd_id, 1 запрос в минуту). Задача пробы — понять состав полей, типы операций, за какие
// дни есть строки (еженедельный и ежедневный отчёт), есть ли srid / chrt_id для связи с wb_orders и размером.
// Только чтение из WB, в базу не пишет. Репозиторий публичный — в лог: поля, типы операций и число строк, даты;
// суммы по операциям — только владельцу в Telegram (если заданы TELEGRAM_*).
const T = process.env.WB_API_TOKEN;
if (!T) throw new Error('нет секрета WB_API_TOKEN');
const FROM = process.env.FROM || '2026-10-27', TO = process.env.TO || '2026-11-09';
const PERIODS = (process.env.PERIODS || 'weekly,daily').split(',').map(s => s.trim()).filter(Boolean);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MONEY = ['retailPrice', 'retailAmount', 'retailPriceWithDisc', 'forPay', 'ppvzSalesCommission', 'vw', 'vwNds', 'ppvzReward', 'acquiringFee',
  'deliveryService', 'deliveryAmount', 'returnAmount', 'paidStorage', 'penalty', 'additionalPayment', 'deduction', 'paidAcceptance', 'rebillLogisticCost',
  'cashbackAmount', 'cashbackDiscount', 'cashbackCommissionChange', 'installmentCofinancingAmount', 'sellerPromo', 'agencyVat'];
const num = v => { const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(x) ? x : 0; };

async function page(period, rrdid) {
  const url = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';
  for (let a = 1; a <= 6; a++) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: T, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateFrom: FROM, dateTo: TO, limit: 100000, rrdId: rrdid, period }) });
    if (r.status === 429) { console.log(`  429 — жду ${60 * a} с`); await sleep(60000 * a); continue; }
    if (r.status === 204) return [];
    const text = await r.text();
    if (r.status !== 200) throw new Error(`${period}: HTTP ${r.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text); return Array.isArray(j) ? j : (Array.isArray(j && j.data) ? j.data : []);
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
    rows = rows.concat(p); rrd = p[p.length - 1].rrdId;
    await sleep(61000);
  }
  if (!rows.length) { console.log('  строк нет'); continue; }
  const fields = {}; rows.forEach(r => Object.entries(r).forEach(([k, v]) => { (fields[k] = fields[k] || new Set()).add(v === null ? 'null' : typeof v); }));
  console.log(`  всего строк: ${rows.length}; поля (${Object.keys(fields).length}):`);
  console.log('  ' + Object.entries(fields).map(([k, t]) => `${k}:${[...t].join('|')}`).join(', '));
  const cnt = (f) => { const m = {}; rows.forEach(r => { const k = r[f] ?? '—'; m[k] = (m[k] || 0) + 1; }); return m; };
  const show = (f) => console.log(`  ${f}: ` + Object.entries(cnt(f)).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} — ${n}`).join('; '));
  ['sellerOperName', 'docTypeName', 'bonusTypeName', 'officeName', 'country', 'srvDbs', 'isB2b', 'deliveryMethod', 'giBoxTypeName', 'reportType', 'currency'].forEach(f => { if (f in fields) show(f); });
  const rng = f => { const v = rows.map(r => r[f]).filter(Boolean).map(s => String(s).slice(0, 10)).sort(); return v.length ? `${v[0]} … ${v[v.length - 1]}` : '—'; };
  ['rrDate', 'saleDt', 'orderDt', 'dateFrom', 'dateTo', 'createDate'].forEach(f => { if (f in fields) console.log(`  ${f}: ${rng(f)}`); });
  const reps = cnt('reportId'); console.log(`  отчётов (reportId): ${Object.keys(reps).length}`);
  const has = f => rows.filter(r => r[f] !== undefined && r[f] !== null && r[f] !== '' && r[f] !== 0).length;
  ['srid', 'chrtId', 'nmId', 'sku', 'vendorCode', 'techSize', 'orderId', 'shkId'].forEach(f => console.log(`  ${f}: заполнено в ${(has(f) / rows.length * 100).toFixed(1)}% строк`));
  // суммы по операциям — в Telegram
  const byOp = {};
  rows.forEach(r => { const k = r.sellerOperName || '—'; const o = byOp[k] = byOp[k] || { n: 0, qty: 0 }; o.n++; o.qty += num(r.quantity);
    MONEY.forEach(m => { if (m in r) o[m] = (o[m] || 0) + num(r[m]); }); });
  tg.push(`WB отчёт о реализации, ${period}, ${FROM}…${TO}: строк ${rows.length}`);
  Object.entries(byOp).sort((a, b) => b[1].n - a[1].n).forEach(([k, o]) => {
    const parts = MONEY.filter(m => o[m]).map(m => `${m} ${Math.round(o[m]).toLocaleString('ru-RU')}`);
    tg.push(`• ${k}: строк ${o.n}, шт ${o.qty}; ${parts.join(', ')}`);
  });
  const tot = {}; MONEY.forEach(m => tot[m] = rows.reduce((s, r) => s + num(r[m]), 0));
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
