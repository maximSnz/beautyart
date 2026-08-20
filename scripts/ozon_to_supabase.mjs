const OZON = 'https://api-seller.ozon.ru';
const H = { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' };
async function ozon(path, body) {
  const r = await fetch(OZON + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

// 1) весь список товаров
let items = [], last_id = '';
do {
  const r = await ozon('/v3/product/list', { filter: {}, limit: 1000, last_id });
  items = items.concat(r.result?.items || []);
  last_id = r.result?.last_id || '';
} while (last_id);
console.log('total products:', items.length);

const attrs = {}, prices = {}, stocks = {};

// остатки: сначала FBO, потом FBS как запасной
async function fetchStocks(chunk) {
  const body = { filter: { product_id: chunk, offer_id: [], visibility: 'ALL' }, last_id: '', limit: 1000 };
  for (const path of ['/v2/product/info/stocks-by-warehouse/fbo', '/v2/product/info/stocks-by-warehouse/fbs']) {
    try {
      const s = await ozon(path, body);
      const arr = s.result?.items || [];
      if (arr.length) {
        arr.forEach(it => { stocks[it.product_id ?? it.id] = (it.stocks || []).reduce((t, x) => t + (x.present || 0), 0); });
        return path;
      }
    } catch (e) { /* пробуем следующий */ }
  }
  return null;
}

// 2) детали пачками по 100
for (let i = 0; i < items.length; i += 100) {
  const chunk = items.slice(i, i + 100).map(x => x.product_id);

  const a = await ozon('/v4/product/info/attributes', { filter: { product_id: chunk, offer_id: [], visibility: 'ALL' }, last_id: '', limit: 100 });
  if (!a.result?.items?.length && i === 0) console.log('attributes raw:', JSON.stringify(a).slice(0, 500));
  (a.result?.items || []).forEach(it => { attrs[it.id] = it; });

  const p = await ozon('/v4/product/info/prices', { filter: { product_id: chunk, offer_id: [], visibility: 'ALL' }, last_id: '', limit: 100 });
  if (!p.result?.items?.length && i === 0) console.log('prices raw:', JSON.stringify(p).slice(0, 500));
  (p.result?.items || []).forEach(it => { prices[it.product_id ?? it.id] = it; });

  const used = await fetchStocks(chunk);
  if (i === 0) console.log('stocks source:', used || 'none (остатки = 0)');

  console.log('fetched', Math.min(i + 100, items.length), '/', items.length);
}

// 3) собираем строки
const rows = items.map(b => {
  const a = attrs[b.product_id] || {};
  const p = prices[b.product_id] || {};
  return {
    product_id: b.product_id,
    offer_id: a.offer_id ?? b.offer_id ?? '',
    name: a.name ?? '',
    price: Number(p.price ?? 0),
    stock: stocks[b.product_id] || 0,
    visibility: a.visibility ?? '',
    raw: a,
    updated_at: new Date().toISOString()
  };
});

// 4) upsert в Supabase
if (rows.length) {
  const up = await fetch(`${process.env.SUPABASE_URL}/rest/v1/products?on_conflict=product_id`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(rows)
  });
  if (!up.ok) throw new Error(`supabase -> HTTP ${up.status}: ${await up.text()}`);
}
console.log('synced to Supabase:', rows.length, 'products');
