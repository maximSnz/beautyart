// Разовая проверка методов API WB для закупок: карточки, остатки по складам, заказы по регионам, поставки, FBS.
// Только чтение. Репозиторий публичный — печатаем структуру ответов (поля, типы, количество строк) без значений;
// исключение — названия складов и регионов WB (география, не наши данные).
const T = process.env.WB_API_TOKEN;
if (!T) throw new Error('нет секрета WB_API_TOKEN');
const H = { Authorization: T, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const day = n => { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 10); };

async function call(method, url, body) {
  for (let a = 1; a <= 4; a++) {
    const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(20000 * a); continue; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  }
  return { status: 429, json: null, text: '429 after retries' };
}
const PUBLIC = /^(warehouseName|regionName|oblastOkrugName|countryName|officeName|name|federalDistrict|cityName)$/;
function schema(v, key = '', out = [], pad = '') {
  if (Array.isArray(v)) {
    out.push(`${pad}${key}: array[${v.length}]`);
    const keys = new Map(); v.slice(0, 200).forEach(it => { if (it && typeof it === 'object' && !Array.isArray(it)) Object.entries(it).forEach(([k, x]) => { if (!keys.has(k)) keys.set(k, x); }); });
    if (keys.size) keys.forEach((x, k) => schema(x, k, out, pad + '  '));
    else if (v.length) out.push(`${pad}  [элементы]: ${typeof v[0]}`);
  } else if (v && typeof v === 'object') {
    out.push(`${pad}${key || '(ответ)'}: object`);
    Object.entries(v).forEach(([k, x]) => schema(x, k, out, pad + '  '));
  } else out.push(`${pad}${key}: ${v === null ? 'null' : typeof v}`);
  return out;
}
// уникальные значения «географических» полей — для понимания складов и регионов
function geo(arr) {
  if (!Array.isArray(arr)) return;
  const by = {};
  arr.forEach(x => { if (x && typeof x === 'object') Object.entries(x).forEach(([k, v]) => { if (PUBLIC.test(k) && typeof v === 'string') (by[k] = by[k] || new Set()).add(v); }); });
  Object.entries(by).forEach(([k, s]) => console.log(`  ${k}: ${s.size} шт — ${[...s].slice(0, 60).join(' | ')}`));
}
function report(title, res, pick = j => j) {
  console.log(`\n===== ${title} → HTTP ${res.status}`);
  if (res.status !== 200) { console.log((res.text || '').slice(0, 400)); return null; }
  const data = pick(res.json);
  console.log(schema(data).slice(0, 80).join('\n'));
  return data;
}

// 1. Контент: карточки (артикул WB, размеры, штрихкоды)
const cards = report('content: /content/v2/get/cards/list',
  await call('POST', 'https://content-api.wildberries.ru/content/v2/get/cards/list', { settings: { cursor: { limit: 100 }, filter: { withPhoto: -1 } } }));
if (cards?.cards) {
  const sizes = cards.cards.reduce((s, c) => s + (c.sizes || []).length, 0);
  console.log(`  карточек ${cards.cards.length} (первая страница), размеров ${sizes}, карточек с >1 размером ${cards.cards.filter(c => (c.sizes || []).length > 1).length}`);
}

// 2. Остатки: статистика (старый метод) и отчёт аналитики (задание → статус → скачивание)
const st = report('statistics: /api/v1/supplier/stocks', await call('GET', `https://statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=${day(-365)}`));
geo(st);
const task = await call('GET', 'https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains?groupByBarcode=true&groupBySize=true');
report('analytics: /api/v1/warehouse_remains (создание задания)', task);
const taskId = task.json?.data?.taskId;
if (taskId) {
  let ok = false;
  for (let i = 0; i < 12 && !ok; i++) { await sleep(10000); const s = await call('GET', `https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${taskId}/status`); ok = s.json?.data?.status === 'done'; console.log(`  статус задания: ${s.json?.data?.status ?? s.status}`); }
  if (ok) {
    const rem = report('analytics: warehouse_remains/download', await call('GET', `https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${taskId}/download`));
    if (Array.isArray(rem)) { const w = new Set(); rem.forEach(x => (x.warehouses || []).forEach(z => w.add(z.warehouseName))); console.log(`  строк ${rem.length}; склады (${w.size}): ${[...w].join(' | ')}`); }
  }
}

// 3. Заказы со складом и регионом покупателя (за 7 дней)
const ord = report('statistics: /api/v1/supplier/orders', await call('GET', `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${day(-7)}`));
geo(ord);

// 4. Продажи по регионам (аналитика)
const reg = report('analytics: /api/v1/analytics/region-sale', await call('GET', `https://seller-analytics-api.wildberries.ru/api/v1/analytics/region-sale?dateFrom=${day(-28)}&dateTo=${day(-1)}`));
if (reg?.report) geo(reg.report);

// 5. Поставки FBO: склады WB и список поставок
const wh = report('supplies: /api/v1/warehouses', await call('GET', 'https://supplies-api.wildberries.ru/api/v1/warehouses'));
if (Array.isArray(wh)) console.log(`  складов WB: ${wh.length}`);
report('supplies: /api/v1/supplies', await call('POST', 'https://supplies-api.wildberries.ru/api/v1/supplies?limit=50', { dates: [{ from: day(-60), till: day(1), type: 'createDate' }] }));

// 6. FBS: склады продавца
const fbs = report('marketplace: /api/v3/warehouses', await call('GET', 'https://marketplace-api.wildberries.ru/api/v3/warehouses'));
geo(fbs);
