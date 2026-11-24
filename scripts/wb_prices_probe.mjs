// Проба официального API цен WB — «Цены и скидки» (24.11.2026; этап 2 плана price-collection-ozon-wb.md;
// ночная загрузка — шаг 10 wb_daily_load.mjs). Хост discounts-prices-api.wildberries.ru (не витрина).
// Задачи пробы: подтвердить путь, поля и лимиты запросов; проверить, что у токена WB_API_TOKEN включена
// категория «Цены и скидки» (токен действует до 20.04.2027). Только чтение, в базу не пишет.
// Репозиторий публичный — в лог только имена полей, типы и число строк: БЕЗ цен и артикулов.
// Лимит категории «Цены и скидки» (справка WB): 10 запросов / 6 с, интервал 600 мс, «всплеск» 5 запросов.
const T = process.env.WB_API_TOKEN;
if (!T) throw new Error('нет секрета WB_API_TOKEN');
const API = 'https://discounts-prices-api.wildberries.ru';
const H = { Authorization: T, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, url) {
  for (let a = 1; a <= 6; a++) {
    const t0 = Date.now();
    const r = await fetch(url, { method, headers: H });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    if (r.status === 429) { console.log(`  429 — жду ${10 * a} с`); await sleep(10000 * a); continue; }
    return { status: r.status, json, text, ms: Date.now() - t0 };
  }
  return { status: 429, json: null, text: '429 после повторов', ms: 0 };
}
const types = arr => { const t = new Map(); (arr || []).slice(0, 500).forEach(x => Object.entries(x || {}).forEach(([k, v]) => { const s = new Set(t.get(k) || []); s.add(v === null ? 'null' : typeof v); t.set(k, s); })); return [...t].map(([k, s]) => `${k}:${[...s].join('|')}`).join(', '); };

console.log(`Проба цен WB: ${API} (только чтение, без записи)`);

// 1) список товаров с ценами — основная проверка доступа и полей; limit по умолчанию страницы 1000
const p1 = await call('GET', `${API}/api/v2/list/goods/filter?limit=1000&offset=0`);
console.log(`\n1) GET /api/v2/list/goods/filter -> HTTP ${p1.status}`);
if (p1.status !== 200) {
  console.log((p1.text || '').slice(0, 300));
  if (p1.status === 401 || p1.status === 403) console.log('   ВНИМАНИЕ: категория «Цены и скидки» у токена не включена (или токен просрочен) — шаг 10 не заработает.');
  process.exit(0);
}
const list1 = p1.json?.data?.listGoods || [];
const sizes1 = list1.flatMap(g => g.sizes || []);
console.log(`   доступна категория «Цены и скидки»: да; товаров на странице ${list1.length}, размеров ${sizes1.length}`);
console.log(`   поля карточки: ${types(list1)}`);
console.log(`   поля размера: ${types(sizes1)}`);
const ed = {}; list1.forEach(g => { const k = String(g.editableSizePrice); ed[k] = (ed[k] || 0) + 1; });
console.log(`   editableSizePrice (цены по размерам отдельно): ${Object.entries(ed).map(([k, n]) => `${k} — ${n}`).join('; ')}`);
const noPrice = sizes1.filter(s => s.price == null || s.discountedPrice == null).length;
console.log(`   размеров без price или discountedPrice: ${noPrice}`);
console.log(`   лимит метода (справка WB): 10 запросов / 6 с, интервал 600 мс, всплеск 5`);

// 2) пагинация: вторая страница (если первая заполнена)
if (list1.length >= 1000) {
  const p2 = await call('GET', `${API}/api/v2/list/goods/filter?limit=1000&offset=1000`);
  const list2 = p2.json?.data?.listGoods || [];
  console.log(`\n2) пагинация: страница 2 (offset=1000) -> HTTP ${p2.status}, товаров ${list2.length}`);
  const dup = new Set(list1.map(g => g.nmID)).size + new Set(list2.map(g => g.nmID)).size - new Set([...list1, ...list2].map(g => g.nmID)).size;
  console.log(`   повтор артикулов между страницами: ${dup}`);
} else console.log(`\n2) пагинация: все товары уместились на одной странице (${list1.length} < 1000) — вторая страница не нужна`);

// 3) размеры одного товара с ценами (метод отдельный; доступен, когда editableSizePrice = true)
const first = list1.find(g => g.editableSizePrice && g.nmID != null);
if (!first) console.log('\n3) /api/v2/list/goods/size/nm: нет товара с editableSizePrice=true — метод не проверен');
else {
  const s = await call('GET', `${API}/api/v2/list/goods/size/nm?limit=1000&nmID=${first.nmID}`);
  const rows = s.json?.data?.listGoods || [];
  console.log(`\n3) GET /api/v2/list/goods/size/nm -> HTTP ${s.status}, размеров ${rows.length}`);
  console.log(`   поля размера: ${types(rows)}`);
}

// 4) проверка лимита «всплеском»: 8 запросов без паузы — сколько прошло до первого 429 (без повторов — смотрим сырой статус)
console.log('\n4) проверка лимита (8 запросов подряд, limit=1):');
const raw = async url => { const t0 = Date.now(); const r = await fetch(url, { headers: H }); const t = await r.text().catch(() => ''); return { status: r.status, ms: Date.now() - t0, len: t.length }; };
const stamp = [];
for (let i = 0; i < 8; i++) { const r = await raw(`${API}/api/v2/list/goods/filter?limit=1&offset=0`); stamp.push(r.status); }
const okN = stamp.filter(s => s === 200).length;
console.log(`   статусы: ${stamp.join(', ')}; 200 — ${okN} из 8${stamp.includes(429) ? '; 429 — лимит подтверждён' : '; 429 не было (лимит не достигнут либо выше заявленного)'}`);
