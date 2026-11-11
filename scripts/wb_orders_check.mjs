// Разовая сверка числа заказов WB из двух методов API (11.11.2026): статистика supplier/orders (её грузит wb-daily-load)
// против воронки продаж аналитики (nm-report — те же цифры, что «Воронка продаж» в кабинете).
// Повод: «Лента заказов» кабинета за 09–10.11 показала на 4–6% больше заказов, чем supplier/orders.
// Только чтение из WB, в базу не пишет. Репозиторий публичный — печатаем только отношения в % и число артикулов, без штук и рублей.
const T = process.env.WB_API_TOKEN;
if (!T) throw new Error('нет секрета WB_API_TOKEN');
const H = { Authorization: T, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DAYS = (process.env.DAYS || '2026-11-09,2026-11-10').split(',').map(s => s.trim()).filter(Boolean);
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

async function call(method, url, body) {
  for (let a = 1; a <= 6; a++) {
    const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(25000 * a); continue; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  }
  return { status: 429, json: null, text: '429 после повторов' };
}

// 1) supplier/orders: все заказы с изменениями от самого раннего дня − 1 (как ночная загрузка), по дню date (Мск) и nmId
const o = await call('GET', `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${shift(DAYS[0], -1)}`);
if (o.status !== 200) throw new Error(`supplier/orders -> HTTP ${o.status}: ${(o.text || '').slice(0, 300)}`);
const API = {}; // день → nmId → шт (строка = единица товара)
for (const x of o.json || []) { const d = String(x.date).slice(0, 10); if (!DAYS.includes(d)) continue; (API[d] = API[d] || {})[x.nmId] = (API[d][x.nmId] || 0) + 1; }

// 2) воронка: nm-report/detail за каждый день (весь магазин, постранично), ordersCount по артикулу
for (const d of DAYS) {
  const F = {}; let page = 1, more = true, firstFields = null;
  while (more) {
    const r = await call('POST', 'https://seller-analytics-api.wildberries.ru/api/v2/nm-report/detail', {
      timezone: 'Europe/Moscow', period: { begin: `${d} 00:00:00`, end: `${d} 23:59:59` }, orderBy: { field: 'ordersCount', mode: 'desc' }, page });
    if (r.status !== 200) { console.log(`${d}: воронка -> HTTP ${r.status}: ${(r.text || '').slice(0, 300)}`); more = false; break; }
    const cards = r.json?.data?.cards || [];
    if (!firstFields && cards[0]) firstFields = Object.keys(cards[0].statistics?.selectedPeriod || {}).join(', ');
    cards.forEach(c => { const n = c.statistics?.selectedPeriod?.ordersCount || 0; if (n) F[c.nmID] = (F[c.nmID] || 0) + n; });
    more = !!r.json?.data?.isNextPage; page++; if (more) await sleep(21000); // лимит метода — 3 запроса в минуту
  }
  const a = API[d] || {}, sa = Object.values(a).reduce((s, v) => s + v, 0), sf = Object.values(F).reduce((s, v) => s + v, 0);
  const nm = new Set([...Object.keys(a), ...Object.keys(F)]);
  let more2 = 0, less = 0, eq = 0; nm.forEach(k => { const x = F[k] || 0, y = a[k] || 0; if (x > y) more2++; else if (x < y) less++; else eq++; });
  if (firstFields) console.log(`поля воронки: ${firstFields}`);
  console.log(`${d}: воронка ÷ supplier/orders = ${sa ? (sf / sa * 100).toFixed(1) : '—'}% | артикулов: совпало ${eq}, в воронке больше ${more2}, в воронке меньше ${less}`);
  await sleep(21000);
}
console.log('Для сравнения: «Лента заказов» кабинета ÷ supplier/orders — 09.11: 104,6%, 10.11: 106,3% (по московскому дню).');
