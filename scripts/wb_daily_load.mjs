// Ночная загрузка WB (только ИП) — шаг 1 плана переноса WB (ROADMAP, этап 1; purchasing.md, «Склады WB»).
// Заказы — «Лента заказов» API (с 11.11.2026; sql/2026-11-11_wb_orders_feed.sql), остатки — warehouse_remains, поставки — supplies.
// Таблицы — sql/2026-11-10_wb_daily_load.sql (beautyart-docs): wb_orders, wb_stock_history, wb_supplies, wb_supply_goods;
// финансовый отчёт (шаг 4, 13.11.2026) — sql/2026-11-13_wb_charges.sql: wb_charges.
// Режимы: WRITE=1 — запись (upsert) в базу ИП; иначе ПРОВЕРКА: всё читается и собирается, в базу ничего не пишется.
// Репозиторий публичный: в лог — только число строк, названия складов и округов, поля ответов; штуки и рубли не печатаем.
const T = process.env.WB_API_TOKEN, SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!T || !SB || !KEY) throw new Error('нет секретов WB_API_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
const H = { Authorization: T, 'Content-Type': 'application/json' }, SR = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const msk = (n = 0) => new Date(Date.now() + 3 * 36e5 + n * 864e5).toISOString().slice(0, 10); // дата по Москве
const FEED_DAYS = Math.min(30, Math.max(1, Number(process.env.FEED_DAYS) || 14)); // глубина ленты: по умолчанию 14 дн, разовая догрузка — до 30 (предел WB — 31 день назад)
const YEST = msk(-1), D = process.env.DAY || YEST, SNAPSHOT = D === YEST, WRITE = process.env.WRITE === '1';
import fs from 'node:fs';
// итоги шагов для журнала бота администратора (scripts/admin_notify.mjs, LOAD=wb, читает load_summary.txt; в публичный лог не печатается)
const SUM = [], note = t => { SUM.push(t); try { fs.writeFileSync('load_summary.txt', SUM.join('\n') + '\n'); } catch (e) {} };
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
  const r = await fetch(`${SB}/rest/v1/wb_products?select=chrt_id,nm_id,tech_size,vendor_code,barcodes&order=chrt_id&limit=1000&offset=${off}`, { headers: SR });
  if (!r.ok) throw new Error(`supabase wb_products -> HTTP ${r.status}: ${await r.text()}`);
  const p = await r.json(); prod.push(...p); if (p.length < 1000) break;
}
const BY_BC = new Map(); prod.forEach(p => (p.barcodes || []).forEach(b => BY_BC.set(String(b), p.chrt_id)));
const BY_NM = new Map(); prod.forEach(p => BY_NM.set(`${p.nm_id}|${p.tech_size}`, p.chrt_id));
const BY_CHRT = new Map(prod.map(p => [p.chrt_id, p]));
const chrtOf = (bc, nm, ts) => BY_BC.get(String(bc)) ?? BY_NM.get(`${nm}|${ts}`) ?? null;
console.log(`\n0) База товаров WB: размеров ${prod.length}, ШК ${BY_BC.size}`);

// 1) Заказы — «Лента заказов» API (с 11.11.2026; статистика supplier/orders теряла 12–16% заказов в статусе «создан»).
//    Период ленты — по дате ТЕКУЩЕГО статуса: берём всё, что меняло статус с D−13 по сейчас (новые заказы, выкупы, отмены);
//    строка = заказ (srid), повторная загрузка перезаписывает ту же строку. День заказа — createdAt по Москве.
//    Лимит метода — 1 запрос в минуту, страница до 1000 заказов, глубина — 31 день.
const mskTs = v => { const t = Date.parse(v); return isNaN(t) ? null : new Date(t + 3 * 36e5).toISOString().slice(0, 19); };
const nowMsk = () => new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 19) + '.00000+03:00';
const feed = []; let snap = null, off = 0;
for (let page = 0; page < 40; page++) {
  const r = need(await call('POST', 'https://seller-analytics-api.wildberries.ru/api/analytics/v1/order-feed', {
    selectedPeriod: { start: `${shift(D, -(FEED_DAYS - 1))}T00:00:00.00000+03:00`, end: nowMsk() },
    pagination: { offset: off, limit: 1000, ...(snap ? { snapshotTime: snap } : {}) } }), 'order-feed');
  const os = r?.data?.orders || []; snap = r?.data?.snapshotTime || snap; feed.push(...os); off += os.length;
  if (os.length < 1000) break;
  await sleep(61000);
}
console.log(`\n1) Заказы — лента (статус менялся с ${shift(D, -(FEED_DAYS - 1))}): строк ${feed.length}; поля: ${fields(feed)}`);
const orders = feed.map(x => { const p = BY_CHRT.get(x.chrtId); const st = String(x.status || '');
  return { srid: x.srid, source: 'feed', order_day: (mskTs(x.createdAt) || '').slice(0, 10) || null, order_ts: mskTs(x.createdAt), last_change: mskTs(x.updatedAt),
    nm_id: x.nmId ?? null, chrt_id: x.chrtId ?? null, supplier_article: p?.vendor_code ?? null, tech_size: p?.tech_size ?? null,
    warehouse_name: x.warehouseName || null, warehouse_region: x.warehouseRegion || null, okrug: x.destinationDistrict || null,
    destination_city: x.destinationCity || null, price_with_disc: num(x.sellerPrice), status: st || null,
    is_cancel: /cancel|declin|reject|отказ|отмен/i.test(st), is_b2b: x.isB2b ?? null, is_mp: x.isMp ?? null }; });
if (orders.some(x => !x.srid)) throw new Error('заказ без srid — запись остановлена');
if (orders.length - uniq(orders.map(x => x.srid)).length) throw new Error('srid повторяется в ленте — запись остановлена');
await upsert('wb_orders', 'srid', orders);
note(`заказы (лента): ${orders.length} строк, оформлено за ${D}: ${orders.filter(x => x.order_day === D).length}, отмен среди них: ${orders.filter(x => x.order_day === D && x.is_cancel).length}`);
console.log(`   дни оформления: с ${orders.map(x => x.order_day).sort()[0]} по ${orders.map(x => x.order_day).sort().pop()}`);
console.log(`   статусы: ${uniq(orders.map(x => x.status)).join(' | ')}`);
console.log(`   размер (chrtId) не найден в «Базе товаров WB»: ${orders.filter(x => !BY_CHRT.has(x.chrt_id)).length} строк`);
console.log(`   округа: ${uniq(orders.map(x => x.okrug)).join(' | ')}`);
console.log(`   склады: ${uniq(orders.map(x => x.warehouse_name)).join(' | ')}`);
// строки из статистики (source='stat', до 11.11.2026) за дни D−6…D, которых нет в ленте: доля и признак отмены в статистике
{ const ids = new Set(orders.map(x => x.srid));
  const r = await fetch(`${SB}/rest/v1/wb_orders?select=srid,order_day,is_cancel&source=eq.stat&order_day=gte.${shift(D, -6)}&order_day=lte.${D}&order=srid&limit=5000`, { headers: SR });
  if (r.ok) { const st = await r.json(), miss = st.filter(x => !ids.has(x.srid));
    console.log(`   строки статистики за ${shift(D, -6)}…${D}, которых нет в ленте: ${miss.length ? (miss.length / st.length * 100).toFixed(1) + '%' : '0'} (из них отмена в статистике: ${miss.filter(x => x.is_cancel).length ? (miss.filter(x => x.is_cancel).length / miss.length * 100).toFixed(0) + '%' : '0'})`); } }

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
  note(`остатки за ${D}: ${stock.length} строк, складов ${uniq(stock.map(x => x.warehouse_name)).length}, ШК без размера ${uniq(stock.filter(x => x.chrt_id == null).map(x => x.barcode)).length}${bad ? `, сумма складов ≠ итогу WB у ${bad} позиций` : ''}`);
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
note(`поставки: ${supRows.length}, не принятых (статус < 5): ${supRows.filter(x => (x.status_id ?? 0) < 5).length}`);

// 4) Финансовый отчёт — детализация ежедневных отчётов о реализации (13.11.2026; sql/2026-11-13_wb_charges.sql) → wb_charges.
//    finance-api POST /api/finance/v1/sales-reports/detailed, period=daily; 1 запрос в минуту, страница до 100 000 строк, дальше — по rrdId.
//    Отчёт за день WB формирует на следующий день — каждую ночь берём отчёты за 7 дней до D (досчитанные дни перезапишутся той же строкой);
//    разовая догрузка — FIN_FROM (ручной запуск, fin_from). Ошибка шага или нет таблицы — предупреждение, остальные шаги уже записаны.
const FIN_FROM = /^\d{4}-\d{2}-\d{2}$/.test(process.env.FIN_FROM || '') ? process.env.FIN_FROM : shift(D, -7);
try {
  const t = await fetch(`${SB}/rest/v1/wb_charges?select=rrd_id&limit=1`, { headers: SR });
  if (!t.ok) throw new Error(`нет таблицы wb_charges (HTTP ${t.status}) — запустить sql/2026-11-13_wb_charges.sql в базе ИП`);
  const fin = []; let rrd = 0;
  for (let i = 0; i < 100; i++) {
    if (i) await sleep(61000);
    const r = await call('POST', 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed', { dateFrom: FIN_FROM, dateTo: D, limit: 100000, rrdId: rrd, period: 'daily' });
    if (r.status === 204) break;
    const p = need(r, 'sales-reports/detailed') || [];
    if (!p.length) break;
    fin.push(...p); rrd = p[p.length - 1].rrdId;
    if (p.length < 100000) break;
  }
  const dt = v => (v ? String(v).slice(0, 10) : null);
  const rows = fin.map(x => ({
    rrd_id: x.rrdId, report_id: x.reportId ?? null, report_type: x.reportType ?? null, date_from: dt(x.dateFrom), date_to: dt(x.dateTo),
    rr_date: dt(x.rrDate), sale_dt: dt(x.saleDt), order_dt: dt(x.orderDt), oper_name: x.sellerOperName || null, doc_type: x.docTypeName || null,
    bonus_type: x.bonusTypeName || null, nm_id: x.nmId || null, barcode: x.sku || null, chrt_id: x.nmId ? chrtOf(x.sku, x.nmId, x.techSize) : null,
    vendor_code: x.vendorCode || null, tech_size: x.techSize || null, srid: x.srid || null, quantity: num(x.quantity), delivery_amount: num(x.deliveryAmount),
    return_amount: num(x.returnAmount), retail_price: num(x.retailPrice), retail_amount: num(x.retailAmount), retail_price_with_disc: num(x.retailPriceWithDisc),
    for_pay: num(x.forPay), sales_commission: num(x.ppvzSalesCommission), vw: num(x.vw), vw_nds: num(x.vwNds), ppvz_reward: num(x.ppvzReward),
    acquiring_fee: num(x.acquiringFee), delivery_service: num(x.deliveryService), rebill_logistic_cost: num(x.rebillLogisticCost),
    paid_storage: num(x.paidStorage), paid_acceptance: num(x.paidAcceptance), penalty: num(x.penalty), deduction: num(x.deduction),
    additional_payment: num(x.additionalPayment), cashback_amount: num(x.cashbackAmount), cashback_discount: num(x.cashbackDiscount),
    office_name: x.officeName || null, country: x.country || null, is_b2b: x.isB2b ?? null,
    raw: Object.fromEntries(Object.entries(x).filter(([k, v]) => v !== null && v !== '' && v !== 0 && v !== '0' && v !== false && k !== 'kiz')) }));  // raw — без пустых полей и КИЗ (место)
  const days = uniq(rows.map(r => r.rr_date).filter(Boolean)).sort();
  const noChrt = rows.filter(r => r.nm_id && !r.chrt_id).length;
  console.log(`финансовый отчёт ${FIN_FROM}…${D}: строк ${rows.length}, отчётов ${uniq(rows.map(r => r.report_id)).length}, дни операций ${days[0] || '—'} … ${days[days.length - 1] || '—'}, без размера ${noChrt}`);
  await upsert('wb_charges', 'rrd_id', rows);
  note(`финансовый отчёт: строк ${rows.length}, последний день ${days[days.length - 1] || '—'}${noChrt ? `, без размера ${noChrt}` : ''}`);
} catch (e) { console.log(`⚠️ финансовый отчёт: ${e.message}`); note(`⚠️ финансовый отчёт: ${e.message.slice(0, 200)}`); }

console.log(`\n${WRITE ? 'Записано' : 'Режим проверки — в базу НЕ записано. Было бы выполнено'}:`); DONE.forEach(x => console.log('  ' + x));
