// Ночная загрузка WB (только ИП) — шаг 1 плана переноса WB (ROADMAP, этап 1; purchasing.md, «Склады WB»).
// Таблицы — sql/2026-11-10_wb_daily_load.sql (beautyart-docs): wb_orders, wb_stock_history, wb_supplies, wb_supply_goods.
// Режимы: WRITE=1 — запись (upsert) в базу ИП; иначе ПРОВЕРКА: всё читается и собирается, в базу ничего не пишется.
// Репозиторий публичный: в лог — только число строк, названия складов и округов, поля ответов; штуки и рубли не печатаем.
const T = process.env.WB_API_TOKEN, SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!T || !SB || !KEY) throw new Error('нет секретов WB_API_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
const H = { Authorization: T, 'Content-Type': 'application/json' }, SR = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const msk = (n = 0) => new Date(Date.now() + 3 * 36e5 + n * 864e5).toISOString().slice(0, 10); // дата по Москве
const YEST = msk(-1), D = process.env.DAY || YEST, SNAPSHOT = D === YEST, WRITE = process.env.WRITE === '1';
const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

async function call(method, url, body) {
  for (let a = 1; a <= 5; a++) {
    const r = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await sleep(20000 * a); continue; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  }
  return { status: 429, json: null, text: '429 после повторов' };
}
const need = (res, what) => { if (res.status !== 200) throw new Error(`${what} -> HTTP ${res.status}: ${(res.text || '').slice(0, 300)}`); return res.json; };
const fields = arr => [...new Set((arr || []).slice(0, 200).flatMap(x => Object.keys(x || {})))].join(', ');
const uniq = a => [...new Set(a)];
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const ts = v => (!v || String(v).startsWith('0001-')) ? null : v;
const DONE = [];
async function upsert(table, key, rows) {
  if (!WRITE) { DONE.push(`${table}: было бы записано строк ${rows.length}`); return; }
  for (let i = 0; i < rows.length; i += 500) {
    const r = await fetch(`${SB}/rest/v1/${table}?on_conflict=${key}`, { method: 'POST', headers: { ...SR, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
    if (!r.ok) throw new Error(`supabase ${table} -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  DONE.push(`${table}: записано строк ${rows.length}`);
}

console.log(`Загрузка WB: день ${D}, режим ${WRITE ? 'ЗАПИСЬ' : 'ПРОВЕРКА (в базу ничего не пишется)'}${SNAPSHOT ? '' : ' — день не вчерашний: снимок остатков пропускается'}`);

// таблицы загрузки должны быть в базе (иначе — стоп до любой записи)
for (const t of ['wb_orders', 'wb_stock_history', 'wb_supplies', 'wb_supply_goods']) {
  const r = await fetch(`${SB}/rest/v1/${t}?select=*&limit=1`, { headers: SR });
  if (!r.ok) throw new Error(`нет таблицы ${t} (HTTP ${r.status}) — запустить sql/2026-11-10_wb_daily_load.sql в базе ИП`);
}

// 0) «База товаров WB»: ШК → размер (chrt_id); только чтение
const prod = [];
for (let off = 0; ; off += 1000) {
  const r = await fetch(`${SB}/rest/v1/wb_products?select=chrt_id,nm_id,tech_size,barcodes&order=chrt_id&limit=1000&offset=${off}`, { headers: SR });
  if (!r.ok) throw new Error(`supabase wb_products -> HTTP ${r.status}: ${await r.text()}`);
  const p = await r.json(); prod.push(...p); if (p.length < 1000) break;
}
const BY_BC = new Map(); prod.forEach(p => (p.barcodes || []).forEach(b => BY_BC.set(String(b), p.chrt_id)));
const BY_NM = new Map(); prod.forEach(p => BY_NM.set(`${p.nm_id}|${p.tech_size}`, p.chrt_id));
const chrtOf = (bc, nm, ts) => BY_BC.get(String(bc)) ?? BY_NM.get(`${nm}|${ts}`) ?? null;
console.log(`\n0) База товаров WB: размеров ${prod.length}, ШК ${BY_BC.size}`);

// 1) Заказы: все изменённые за 14 дней до D (новые заказы и поздние отмены) — строка = заказ (srid), повторная загрузка
//    перезаписывает ту же строку. День заказа — дата из поля date (время Москвы, как в кабинете WB).
const o = need(await call('GET', `https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=${shift(D, -13)}`), 'supplier/orders') || [];
console.log(`\n1) Заказы (изменённые с ${shift(D, -13)}): строк ${o.length}; поля: ${fields(o)}`);
const orders = o.map(x => ({
  srid: x.srid, order_day: String(x.date).slice(0, 10), order_ts: x.date, last_change: x.lastChangeDate,
  nm_id: x.nmId, barcode: x.barcode ? String(x.barcode) : null, chrt_id: chrtOf(x.barcode, x.nmId, x.techSize),
  supplier_article: x.supplierArticle, tech_size: x.techSize, warehouse_name: x.warehouseName, warehouse_type: x.warehouseType,
  country: x.countryName, okrug: x.oblastOkrugName, region: x.regionName,
  total_price: num(x.totalPrice), discount_percent: num(x.discountPercent), spp: num(x.spp), finished_price: num(x.finishedPrice),
  price_with_disc: num(x.priceWithDisc), is_cancel: !!x.isCancel, cancel_date: x.isCancel ? ts(x.cancelDate) : null, g_number: x.gNumber ?? null,
}));
if (orders.some(x => !x.srid)) throw new Error('заказ без srid — запись остановлена');
await upsert('wb_orders', 'srid', orders);
const dayRows = orders.filter(x => x.order_day === D);
console.log(`   заказов за ${D}: строк ${dayRows.length}; srid пустой: ${orders.filter(x => !x.srid).length}; srid повторяется: ${orders.length - uniq(orders.map(x => x.srid)).length}`);
console.log(`   без размера в «Базе товаров WB»: ${orders.filter(x => x.chrt_id == null).length} строк, артикулы: ${uniq(orders.filter(x => x.chrt_id == null).map(x => x.supplier_article)).slice(0, 20).join(' | ') || '—'}`);
console.log(`   страны: ${uniq(orders.map(x => x.country)).join(' | ')}`);
console.log(`   округа: ${uniq(orders.map(x => x.okrug)).join(' | ')}`);
console.log(`   склады: ${uniq(orders.map(x => `${x.warehouse_name} (${x.warehouse_type})`)).join(' | ')}`);
console.log(`   дни заказов: с ${orders.map(x => x.order_day).sort()[0]} по ${orders.map(x => x.order_day).sort().pop()}`);

// 2) Остатки: снимок на сейчас (отчёт аналитики: задание → статус → скачивание) — только если D = вчера, report_date = D
if (SNAPSHOT) {
  const t = need(await call('GET', 'https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains?groupByBarcode=true&groupBySize=true&groupByNm=true'), 'warehouse_remains');
  const id = t?.data?.taskId; let ok = false;
  for (let i = 0; i < 18 && !ok; i++) { await sleep(10000); const s = await call('GET', `https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${id}/status`); ok = s.json?.data?.status === 'done'; }
  if (!ok) throw new Error('warehouse_remains: задание не готово за 3 минуты');
  const rem = need(await call('GET', `https://seller-analytics-api.wildberries.ru/api/v1/warehouse_remains/tasks/${id}/download`), 'warehouse_remains/download') || [];
  const SERVICE = /^(Всего находится на складах)$/; // сумма по складам — не храним, только сверяем
  const stock = []; let bad = 0;
  rem.forEach(x => {
    const ws = x.warehouses || [], total = ws.find(w => SERVICE.test(w.warehouseName))?.quantity ?? null;
    const real = ws.filter(w => !SERVICE.test(w.warehouseName) && !/^В пути/.test(w.warehouseName));
    if (total != null && real.reduce((s, w) => s + (w.quantity || 0), 0) !== total) bad++;
    ws.filter(w => !SERVICE.test(w.warehouseName)).forEach(w => stock.push({ report_date: D, barcode: String(x.barcode), chrt_id: chrtOf(x.barcode, x.nmId, x.techSize),
      nm_id: x.nmId, warehouse_name: w.warehouseName, qty: w.quantity }));
  });
  console.log(`\n2) Остатки (снимок за ${D}): позиций ${rem.length}; поля позиции: ${fields(rem)}; строк «позиция × склад» ${stock.length}`);
  console.log(`   склады: ${uniq(stock.map(x => x.warehouse_name)).join(' | ')}`);
  console.log(`   ШК без размера в «Базе товаров WB»: ${uniq(stock.filter(x => x.chrt_id == null).map(x => x.barcode)).length}; ШК повторяется в отчёте: ${rem.length - uniq(rem.map(x => x.barcode)).length}`);
  console.log(`   сумма складов ≠ «Всего находится на складах»: ${bad} позиций из ${rem.length}`);
  if (!rem.length) throw new Error('отчёт остатков пустой — запись остановлена');
  await upsert('wb_stock_history', 'report_date,barcode,warehouse_name', stock);
}

// 3) Поставки FBO за 120 дней: карточка поставки (СЦ, статус, количества) и состав (ШК × количество)
const sl = need(await call('POST', 'https://supplies-api.wildberries.ru/api/v1/supplies?limit=1000', { dates: [{ from: shift(D, -120), till: msk(1), type: 'createDate' }] }), 'supplies') || [];
console.log(`\n3) Поставки за 120 дней: ${sl.length}; поля списка: ${fields(sl)}`);
console.log(`   статусы (statusID): ${uniq(sl.map(x => x.statusID)).sort().join(', ')}; без supplyID: ${sl.filter(x => x.supplyID == null).length}; без preorderID: ${sl.filter(x => x.preorderID == null).length}`);
let shown = false; const goodsFields = new Set(), sc = {}; let goodsRows = 0, goodsNoChrt = 0; const supRows = [], goodRows = [];
for (const x of sl) {
  const sid = x.supplyID ?? x.preorderID, isPre = x.supplyID == null;
  const d = await call('GET', `https://supplies-api.wildberries.ru/api/v1/supplies/${sid}${isPre ? '?isPreorderID=true' : ''}`);
  if (d.status !== 200) { console.log(`   поставка ${isPre ? 'заказ' : ''}${sid}: HTTP ${d.status} ${(d.text || '').slice(0, 150)}`); await sleep(1500); continue; }
  sc[`${d.json?.warehouseName} / статус ${x.statusID}`] = (sc[`${d.json?.warehouseName} / статус ${x.statusID}`] || 0) + 1;
  const c = d.json || {};
  if (x.supplyID != null) supRows.push({ supply_id: x.supplyID, preorder_id: x.preorderID ?? null, status_id: x.statusID ?? c.statusID ?? null,
    box_type_id: x.boxTypeID ?? c.boxTypeID ?? null, is_box_on_pallet: x.isBoxOnPallet ?? c.isBoxOnPallet ?? null,
    create_date: ts(x.createDate), supply_date: ts(x.supplyDate), fact_date: ts(x.factDate), updated_date: ts(x.updatedDate),
    warehouse_name: c.warehouseName || null, actual_warehouse_name: c.actualWarehouseName || null, transit_warehouse_name: c.transitWarehouseName || null,
    quantity: num(c.quantity), accepted_quantity: num(c.acceptedQuantity), ready_for_sale_quantity: num(c.readyForSaleQuantity),
    unloading_quantity: num(c.unloadingQuantity), storage_coef: num(c.storageCoef), delivery_coef: num(c.deliveryCoef) });
  const g = await call('GET', `https://supplies-api.wildberries.ru/api/v1/supplies/${sid}/goods?limit=1000${isPre ? '&isPreorderID=true' : ''}`);
  if (g.status !== 200) { if (!shown) { console.log(`   состав поставки: HTTP ${g.status} ${(g.text || '').slice(0, 200)}`); shown = true; } await sleep(1500); continue; }
  const items = Array.isArray(g.json) ? g.json : (g.json?.goods || g.json?.data || []);
  items.forEach(i => { Object.keys(i || {}).forEach(k => goodsFields.add(k)); goodsRows++; if (chrtOf(i.barcode, i.nmID ?? i.nmId, i.techSize) == null) goodsNoChrt++;
    if (x.supplyID != null && i.barcode) goodRows.push({ supply_id: x.supplyID, barcode: String(i.barcode), nm_id: i.nmID ?? i.nmId ?? null,
      chrt_id: chrtOf(i.barcode, i.nmID ?? i.nmId, i.techSize), vendor_code: i.vendorCode ?? null, tech_size: i.techSize ?? null,
      quantity: num(i.quantity), accepted_quantity: num(i.acceptedQuantity), ready_for_sale_quantity: num(i.readyForSaleQuantity),
      unloading_quantity: num(i.unloadingQuantity), supplier_box_amount: num(i.supplierBoxAmount) }); });
  await sleep(1500);
}
Object.entries(sc).forEach(([k, n]) => console.log(`   ${k} — поставок ${n}`));
console.log(`   состав: строк ${goodsRows}; поля: ${[...goodsFields].join(', ') || '—'}; без размера в «Базе товаров WB»: ${goodsNoChrt}`);

// поставки без supplyID (ещё не созданные заказы на поставку) пока не храним — в состав «в пути» они не входят
const gk = new Map(); goodRows.forEach(g => { const k = `${g.supply_id}|${g.barcode}`; if (gk.has(k)) { const a = gk.get(k); ['quantity','accepted_quantity','ready_for_sale_quantity','unloading_quantity','supplier_box_amount'].forEach(f => a[f] = (a[f] ?? 0) + (g[f] ?? 0)); } else gk.set(k, { ...g }); });
await upsert('wb_supplies', 'supply_id', supRows);
await upsert('wb_supply_goods', 'supply_id,barcode', [...gk.values()]);

console.log(`\n${WRITE ? 'Записано' : 'Режим проверки — в базу НЕ записано. Было бы выполнено'}:`); DONE.forEach(x => console.log('  ' + x));
