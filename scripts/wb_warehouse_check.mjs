// Разовая проверка названий складов WB: совпадают ли склады в заказах, остатках и поставках
// (вопрос 10.11.2026: в заказах есть «Рязанская обл.», в остатках — только «Склад WB РФ»).
// Только чтение из WB, в базу не пишет. Репозиторий публичный — печатаем только названия складов, даты
// и число артикулов; штуки и рубли не печатаем.
const T = process.env.WB_API_TOKEN;
if (!T) throw new Error('нет секрета WB_API_TOKEN');
const H = { Authorization: T, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

async function call(method, url, body) {
  for (let a = 1; a <= 4; a++) {
    const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(20000 * a); continue; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  }
  return { status: 429, json: null, text: '429 after retries' };
}

// 1. Заказы за 28 дней: по каждому названию склада — тип, первый и последний день, дней с заказами, артикулов
const o = await call('GET', `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${day(-28)}`);
console.log(`\n===== Заказы за 28 дней → HTTP ${o.status}`);
const ord = Array.isArray(o.json) ? o.json : [];
const W = {};
ord.forEach(x => {
  const w = W[x.warehouseName] = W[x.warehouseName] || { types: new Set(), days: new Set(), nm: new Set() };
  w.types.add(x.warehouseType || '—'); w.days.add(String(x.date || '').slice(0, 10)); w.nm.add(x.nmId);
});
Object.entries(W).sort((a, b) => b[1].days.size - a[1].days.size).forEach(([n, w]) => {
  const d = [...w.days].sort();
  console.log(`  ${n} | тип: ${[...w.types].join(', ')} | с ${d[0]} по ${d[d.length - 1]} | дней с заказами ${d.length} | артикулов ${w.nm.size}`);
});
// какие названия встречаются в какой день — видно, было ли переименование
console.log('\n  По дням (какие склады были в заказах):');
const byDay = {};
ord.forEach(x => { const d = String(x.date || '').slice(0, 10); (byDay[d] = byDay[d] || new Set()).add(x.warehouseName); });
Object.keys(byDay).sort().forEach(d => console.log(`  ${d}: ${[...byDay[d]].sort().join(' | ')}`));
// общие артикулы у пар «Рязанская обл.» и «Склад WB РФ»
const A = W['Рязанская обл.']?.nm, B = W['Склад WB РФ']?.nm;
if (A && B) console.log(`\n  Артикулов и в «Рязанская обл.», и в «Склад WB РФ»: ${[...A].filter(x => B.has(x)).length} (только Рязанская ${A.size}, только РФ ${B.size})`);

// 2. Остатки сейчас: названия складов (отчёт аналитики: задание → статус → скачивание)
const t = await call('GET', 'https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains?groupByBarcode=true&groupBySize=true');
const id = t.json?.data?.taskId;
console.log(`\n===== Остатки (задание) → HTTP ${t.status}`);
if (id) {
  let ok = false;
  for (let i = 0; i < 12 && !ok; i++) { await sleep(10000); const s = await call('GET', `https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${id}/status`); ok = s.json?.data?.status === 'done'; }
  if (ok) {
    const r = await call('GET', `https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${id}/download`);
    const w = new Set(); (r.json || []).forEach(x => (x.warehouses || []).forEach(z => w.add(z.warehouseName)));
    console.log(`  склады (${w.size}): ${[...w].join(' | ')}`);
  } else console.log('  задание не готово за 2 минуты');
}

// 3. Поставки FBO за 90 дней: на какой склад записаны (список → карточка поставки)
const s = await call('POST', 'https://supplies-api.wildberries.ru/api/v1/supplies?limit=100', { dates: [{ from: day(-90), till: day(1), type: 'createDate' }] });
console.log(`\n===== Поставки за 90 дней → HTTP ${s.status}`);
const sup = Array.isArray(s.json) ? s.json : [];
console.log(`  поставок в списке: ${sup.length}; поля: ${Object.keys(sup[0] || {}).join(', ')}`);
const names = {};
for (const x of sup.slice(0, 30)) {
  const sid = x.supplyID ?? x.supplyId ?? x.preorderID ?? x.id;
  if (sid == null) continue;
  const d = await call('GET', `https://supplies-api.wildberries.ru/api/v1/supplies/${sid}`);
  if (d.status !== 200) { console.log(`  поставка ${sid}: HTTP ${d.status} ${(d.text || '').slice(0, 200)}`); await sleep(2000); continue; }
  const j = d.json || {};
  const key = Object.entries(j).filter(([k, v]) => /warehouse/i.test(k) && typeof v === 'string').map(([k, v]) => `${k}=${v}`).join('; ') || '(нет полей склада)';
  names[key] = (names[key] || 0) + 1;
  if (Object.keys(names).length === 1 && names[key] === 1) console.log(`  поля карточки поставки: ${Object.keys(j).join(', ')}`);
  await sleep(2000);
}
Object.entries(names).forEach(([k, n]) => console.log(`  ${k} — поставок ${n}`));
