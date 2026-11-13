// Ночная загрузка WB (только ИП) — шаг 1 плана переноса WB (ROADMAP, этап 1; purchasing.md, «Склады WB»).
// Заказы — «Лента заказов» API (с 11.11.2026; sql/2026-11-11_wb_orders_feed.sql), остатки — warehouse_remains, поставки — supplies.
// Таблицы — sql/2026-11-10_wb_daily_load.sql (beautyart-docs): wb_orders, wb_stock_history, wb_supplies, wb_supply_goods;
// финансовый отчёт (шаг 4, 13.11.2026) — sql/2026-11-13_wb_charges.sql: wb_charges; реклама (шаг 5) — sql/2026-11-13_wb_ad_spend.sql: wb_ad_spend;
// маржа по размеру и дню (шаг 6) — sql/2026-11-13_wb_cf_daily.sql: wb_cf_daily.
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

// 5) Реклама — расход по кампании, карточке (nm_id) и дню (13.11.2026; sql/2026-11-13_wb_ad_spend.sql) → wb_ad_spend.
//    /adv/v1/upd — кампании с фактическими затратами за окно (до 31 дня), /adv/v3/fullstats — по дням и карточкам (до 50 кампаний, 3 запроса
//    в минуту), площадки (сайт, приложения) складываются. Каждую ночь — 7 дней до D, дни окна заменяются целиком; догрузка — ADS_FROM.
//    Ошибка шага или нет таблицы — предупреждение.
const ADS_FROM = /^\d{4}-\d{2}-\d{2}$/.test(process.env.ADS_FROM || '') ? process.env.ADS_FROM : shift(D, -7);
try {
  const t = await fetch(`${SB}/rest/v1/wb_ad_spend?select=day&limit=1`, { headers: SR });
  if (!t.ok) throw new Error(`нет таблицы wb_ad_spend (HTTP ${t.status}) — запустить sql/2026-11-13_wb_ad_spend.sql в базе ИП`);
  const ad = new Map(); let nCamp = 0, updSum = 0;
  for (let a = ADS_FROM; a <= D; a = shift(a, 31)) {
    const b = shift(a, 30) < D ? shift(a, 30) : D;
    const upd = need(await call('GET', `https://advert-api.wildberries.ru/adv/v1/upd?from=${a}&to=${b}`), 'adv/v1/upd') || [];
    updSum += upd.reduce((s, u) => s + (Number(u.updSum) || 0), 0);
    const ids = uniq(upd.map(u => u.advertId)); nCamp += ids.length;
    for (let i = 0; i < ids.length; i += 50) {
      await sleep(21000);
      const st = need(await call('GET', `https://advert-api.wildberries.ru/adv/v3/fullstats?ids=${ids.slice(i, i + 50).join(',')}&beginDate=${a}&endDate=${b}`), 'adv/v3/fullstats') || [];
      for (const c of st) for (const d of (c.days || [])) for (const ap of (d.apps || [])) for (const n of (ap.nms || [])) {
        const day = String(d.date).slice(0, 10); if (day < a || day > b) continue;
        const k = `${c.advertId}|${n.nmId}|${day}`;
        const o = ad.get(k) || { advert_id: c.advertId, nm_id: n.nmId, day, amount: 0, views: 0, clicks: 0, atbs: 0, orders: 0, sum_price: 0 };
        o.amount += Number(n.sum) || 0; o.views += Number(n.views) || 0; o.clicks += Number(n.clicks) || 0; o.atbs += Number(n.atbs) || 0;
        o.orders += Number(n.orders) || 0; o.sum_price += Number(n.sum_price) || 0; ad.set(k, o);
      }
    }
  }
  const rows = [...ad.values()].map(o => ({ ...o, amount: Math.round(o.amount * 100) / 100, sum_price: Math.round(o.sum_price * 100) / 100 }));
  const adSum = rows.reduce((s, r) => s + r.amount, 0);
  const share = updSum ? (adSum / updSum * 100).toFixed(1) + '%' : '—';
  console.log(`реклама ${ADS_FROM}…${D}: кампаний с затратами ${nCamp}, строк ${rows.length}, карточек ${uniq(rows.map(r => r.nm_id)).length}; Σ по карточкам / фактические затраты: ${share}`);
  if (WRITE) {
    const r = await fetch(`${SB}/rest/v1/wb_ad_spend?day=gte.${ADS_FROM}&day=lte.${D}`, { method: 'DELETE', headers: SR });
    if (!r.ok) throw new Error(`supabase wb_ad_spend delete -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  await upsert('wb_ad_spend', 'advert_id,nm_id,day', rows);
  note(`реклама: строк ${rows.length}, по карточкам ${share} фактических затрат`);
} catch (e) { console.log(`⚠️ реклама: ${e.message}`); note(`⚠️ реклама: ${e.message.slice(0, 200)}`); }

// 6) Маржа WB по размеру и дню операции (13.11.2026, формула утверждена владельцем; sql/2026-11-13_wb_cf_daily.sql) → wb_cf_daily.
//    to_pay = к перечислению (продажи − возвраты) − доставка − приёмка − штрафы − удержания по товару + доплаты − баллы за отзывы
//    (= «Итого к оплате» кабинета по строкам с товаром; сверка 26.10–01.11 до копейки); mar = to_pay − возмещение издержек − себестоимость
//    на дату × шт (только «Продажа» / «Возврат») − налог 3% продажи − реклама. Реклама карточки за день делится на размеры по выручке заказов
//    размера в этот день (wb_orders, без отмен); нет заказов — по продажам отчёта; нет и их — поровну. Строки без товара (хранение,
//    «WB Продвижение», «Джем») в маржу товара не входят. Окно — 14 дней до D (или с начала догрузки), дни окна заменяются.
const TAX = 0.03;
const CF_FROM = [FIN_FROM, ADS_FROM, shift(D, -14)].sort()[0];
async function readAll(table, q, order) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetch(`${SB}/rest/v1/${table}?${q}&order=${order}&limit=1000&offset=${off}`, { headers: SR });
    if (!r.ok) throw new Error(`supabase ${table} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const p = await r.json(); out.push(...p); if (p.length < 1000) break;
  }
  return out;
}
try {
  const t = await fetch(`${SB}/rest/v1/wb_cf_daily?select=day&limit=1`, { headers: SR });
  if (!t.ok) throw new Error(`нет таблицы wb_cf_daily (HTTP ${t.status}) — запустить sql/2026-11-13_wb_cf_daily.sql в базе ИП`);
  const n = v => Number(v) || 0;
  const ch = await readAll('wb_charges', `select=rrd_id,rr_date,oper_name,doc_type,chrt_id,nm_id,quantity,retail_amount,for_pay,delivery_service,paid_acceptance,penalty,deduction,additional_payment,rebill_logistic_cost,cashback_amount&rr_date=gte.${CF_FROM}&rr_date=lte.${D}`, 'rrd_id');
  const ad = await readAll('wb_ad_spend', `select=advert_id,nm_id,day,amount&day=gte.${CF_FROM}&day=lte.${D}`, 'advert_id,nm_id,day');
  const ord = await readAll('wb_orders', `select=srid,order_day,chrt_id,nm_id,price_with_disc,is_cancel&source=eq.feed&order_day=gte.${CF_FROM}&order_day=lte.${D}`, 'srid');
  const pr = await readAll('wb_product_prices', 'select=id,chrt_id,cost,created_at', 'created_at,id');   // по дате: себестоимость бывает задним числом (файл цен)
  const COST = {}; pr.forEach(x => (COST[x.chrt_id] = COST[x.chrt_id] || []).push(x));
  // себестоимость на дату: последняя запись не позже дня; до первой записи — первая (база товаров WB заполнена 23.10.2026)
  const costAt = (c, d) => { const l = COST[c]; if (!l) return null; let v = l[0].cost; for (const x of l) if (String(x.created_at).slice(0, 10) <= d) v = x.cost; return n(v); };
  const SIZES = {}; prod.forEach(x => (SIZES[x.nm_id] = SIZES[x.nm_id] || []).push(x.chrt_id));
  const CF = new Map(), cf = (c, d, nm) => { const k = `${c}|${d}`; if (!CF.has(k)) CF.set(k, { chrt_id: Number(c), day: d, nm_id: nm ?? BY_CHRT.get(Number(c))?.nm_id ?? null, qty: 0, retail: 0, to_pay: 0, rebill: 0, cogs: 0, tax: 0, ads: 0, mar: 0, no_cost_qty: 0 }); return CF.get(k); };
  let nonItem = 0;
  for (const r of ch) {
    const sg = r.doc_type === 'Возврат' ? -1 : 1;
    const pay = sg * n(r.for_pay) - n(r.delivery_service) - n(r.paid_acceptance) - n(r.penalty) - n(r.deduction) + n(r.additional_payment) - n(r.cashback_amount);
    if (!r.chrt_id) { nonItem++; continue; }
    const o = cf(r.chrt_id, r.rr_date, r.nm_id);
    o.to_pay += pay; o.rebill += n(r.rebill_logistic_cost); o.retail += sg * n(r.retail_amount);
    if (r.oper_name === 'Продажа' || r.oper_name === 'Возврат') {
      const q = sg * n(r.quantity), c = costAt(r.chrt_id, r.rr_date);
      o.qty += q; if (c == null) o.no_cost_qty += Math.abs(q); else o.cogs += q * c;
    }
  }
  const REV = {}; ord.forEach(x => { if (x.is_cancel) return; const k = `${x.order_day}|${x.nm_id}`; (REV[k] = REV[k] || {})[x.chrt_id] = (REV[k][x.chrt_id] || 0) + n(x.price_with_disc); });
  const SALE = {}; ch.forEach(r => { if (r.oper_name !== 'Продажа' || !r.chrt_id) return; const k = `${r.rr_date}|${r.nm_id}`; (SALE[k] = SALE[k] || {})[r.chrt_id] = (SALE[k][r.chrt_id] || 0) + n(r.retail_amount); });
  const how = { orders: 0, sales: 0, equal: 0, lost: 0 };
  for (const a of ad) {
    const k = `${a.day}|${a.nm_id}`; let w = REV[k], src = 'orders';
    if (!w || !Object.values(w).some(v => v > 0)) { w = SALE[k]; src = 'sales'; }
    if (!w || !Object.values(w).some(v => v > 0)) { const sz = SIZES[a.nm_id]; if (!sz) { how.lost++; continue; } w = Object.fromEntries(sz.map(c => [c, 1])); src = 'equal'; }
    how[src]++;
    const tot = Object.values(w).reduce((x, y) => x + Math.max(0, y), 0);
    Object.entries(w).forEach(([c, v]) => { if (v > 0) cf(c, a.day, a.nm_id).ads += n(a.amount) * v / tot; });
  }
  const r2 = v => Math.round(v * 100) / 100;
  const rows = [...CF.values()].map(o => { o.tax = TAX * o.retail; o.mar = o.to_pay - o.rebill - o.cogs - o.tax - o.ads;
    ['retail', 'to_pay', 'rebill', 'cogs', 'tax', 'ads', 'mar'].forEach(f => o[f] = r2(o[f])); return o; });
  const noCost = rows.reduce((s, o) => s + o.no_cost_qty, 0), qty = rows.reduce((s, o) => s + Math.max(0, o.qty), 0);
  console.log(`маржа ${CF_FROM}…${D}: строк ${rows.length}, размеров ${uniq(rows.map(o => o.chrt_id)).length}, строк отчёта без товара ${nonItem}; реклама делится по заказам ${how.orders}, по продажам ${how.sales}, поровну ${how.equal}, без размеров ${how.lost}`);
  if (WRITE) {
    const r = await fetch(`${SB}/rest/v1/wb_cf_daily?day=gte.${CF_FROM}&day=lte.${D}`, { method: 'DELETE', headers: SR });
    if (!r.ok) throw new Error(`supabase wb_cf_daily delete -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  await upsert('wb_cf_daily', 'chrt_id,day', rows);
  note(`маржа: ${CF_FROM}…${D}, строк ${rows.length}${noCost ? `; без себестоимости ${noCost} шт (${qty ? Math.round(noCost / qty * 100) : 0}%)` : ''}${how.lost ? `; реклама без размеров: ${how.lost} строк` : ''}`);
} catch (e) { console.log(`⚠️ маржа: ${e.message}`); note(`⚠️ маржа: ${e.message.slice(0, 200)}`); }

console.log(`\n${WRITE ? 'Записано' : 'Режим проверки — в базу НЕ записано. Было бы выполнено'}:`); DONE.forEach(x => console.log('  ' + x));
