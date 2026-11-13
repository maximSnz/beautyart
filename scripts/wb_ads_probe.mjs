// Проба API рекламы WB (13.11.2026; маржа WB для карт Шухарта — реклама по товарам, решение владельца):
// 1) /adv/v1/promotion/count — кампании и статусы; 2) /adv/v1/upd — фактические затраты по кампаниям за период;
// 3) /adv/v3/fullstats — статистика кампаний по дням и артикулам (до 50 кампаний за запрос, 3 запроса в минуту, период до 31 дня).
// Сверка: Σ fullstats (по артикулам) против Σ upd против удержаний «WB Продвижение» финансового отчёта (wb_charges) за те же дни.
// Только чтение; в лог — поля, число кампаний и артикулов, отношения в %; рубли — владельцу в Telegram.
const T = process.env.WB_API_TOKEN;
if (!T) throw new Error('нет секрета WB_API_TOKEN');
const FROM = process.env.FROM || '2026-10-26', TO = process.env.TO || '2026-11-01';
const H = { Authorization: T };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let a = 1; a <= 6; a++) {
    const r = await fetch(url, { headers: H });
    if (r.status === 429) { console.log(`  429 — жду ${25 * a} с`); await sleep(25000 * a); continue; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    if (r.status !== 200) throw new Error(`${url.split('?')[0]} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
    return json;
  }
  throw new Error('429 после повторов');
}
const keys = (v, p = '', out = new Set()) => {
  if (Array.isArray(v)) { if (v.length && typeof v[0] === 'object') keys(v[0], p + '[]', out); }
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (x && typeof x === 'object') ? keys(x, p ? `${p}.${k}` : k, out) : out.add(p ? `${p}.${k}` : k));
  return out;
};

// 1) кампании
const cnt = await get('https://advert-api.wildberries.ru/adv/v1/promotion/count');
const camps = (cnt.adverts || []).flatMap(g => (g.advert_list || []).map(a => ({ id: a.advertId, type: g.type, status: g.status, changed: a.changeTime })));
const byGrp = {}; camps.forEach(c => { const k = `type ${c.type} / status ${c.status}`; byGrp[k] = (byGrp[k] || 0) + 1; });
console.log(`кампаний: ${camps.length}; ${Object.entries(byGrp).map(([k, n]) => `${k}: ${n}`).join('; ')}`);

// 2) фактические затраты за период
const upd = await get(`https://advert-api.wildberries.ru/adv/v1/upd?from=${FROM}&to=${TO}`) || [];
console.log(`upd: строк ${upd.length}, кампаний ${new Set(upd.map(u => u.advertId)).size}; поля: ${[...keys(upd)].join(', ')}`);
const updSum = upd.reduce((s, u) => s + (Number(u.updSum) || 0), 0);
const payTypes = {}; upd.forEach(u => { payTypes[u.paymentType] = (payTypes[u.paymentType] || 0) + (Number(u.updSum) || 0); });

// 3) fullstats по кампаниям с затратами (статусы 7, 9, 11 — у остальных статистики нет)
const ids = [...new Set(upd.map(u => u.advertId))];
const stats = [];
for (let i = 0; i < ids.length; i += 50) {
  if (i) await sleep(21000);
  const j = await get(`https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${ids.slice(i, i + 50).join(',')}&beginDate=${FROM}&endDate=${TO}`);
  stats.push(...(Array.isArray(j) ? j : []));
}
console.log(`fullstats: кампаний ${stats.length}; поля: ${[...keys(stats)].join(', ')}`);
// Σ по кампаниям (верх), по дням и по артикулам (days[].apps[].nms[] — если так)
let topSum = 0, daySum = 0, nmSum = 0; const nmSet = new Set(), byDay = {};
stats.forEach(s => { topSum += Number(s.sum) || 0;
  (s.days || []).forEach(d => { const day = String(d.date).slice(0, 10); daySum += Number(d.sum) || 0;
    (d.apps || []).forEach(a => (a.nms || a.nm || []).forEach(n => { const v = Number(n.sum) || 0; nmSum += v; nmSet.add(n.nmId); byDay[day] = (byDay[day] || 0) + v; })); }); });
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';
console.log(`артикулов с расходом: ${nmSet.size}; дней: ${Object.keys(byDay).sort().join(', ')}`);
console.log(`Σ по артикулам / Σ кампаний fullstats: ${pct(nmSum, topSum)}; Σ по дням / Σ кампаний: ${pct(daySum, topSum)}; Σ кампаний fullstats / Σ upd: ${pct(topSum, updSum)}`);

const tg = [`WB реклама ${FROM}…${TO}`, `upd (фактические затраты): ${Math.round(updSum).toLocaleString('ru-RU')} ₽ — ${Object.entries(payTypes).map(([k, v]) => `${k} ${Math.round(v).toLocaleString('ru-RU')}`).join(', ')}`,
  `fullstats: по кампаниям ${Math.round(topSum).toLocaleString('ru-RU')} ₽, по дням ${Math.round(daySum).toLocaleString('ru-RU')} ₽, по артикулам ${Math.round(nmSum).toLocaleString('ru-RU')} ₽ (${nmSet.size} арт.)`,
  'по дням: ' + Object.entries(byDay).sort().map(([d, v]) => `${d.slice(8, 10)}.${d.slice(5, 7)} ${Math.round(v).toLocaleString('ru-RU')}`).join('; ')];
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: tg.join('\n'), disable_web_page_preview: true }) });
  console.log(`Telegram: HTTP ${r.status}`);
} else console.log('Telegram не задан — суммы не отправлены');
