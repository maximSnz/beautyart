const OZON = 'https://api-seller.ozon.ru';
const H = { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' };
async function ozon(path, body) {
  const r = await fetch(OZON + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}
const asArr = r => Array.isArray(r?.result) ? r.result : (r?.result?.items || []);

// 1) весь список товаров
let items = [], last_id = '';
do {
  const r = await ozon('/v3/product/list', { filter: {}, limit: 1000, last_id });
  items = items.concat(r.result?.items || []);
  last_id = r.result?.last_id || '';
} while (last_id);
console.log('total products:', items.length);

const attrs = {}, prices = {}, stocks = {};

async function tryBatch(paths, chunk, fill) {
  const body = { filter: { product_id: chunk, offer_id: [], visibility: 'ALL' }, last_id: '', limit: 1000 };
  for (const path of paths) {
    try { const r = await ozon(path, body); const arr = asArr(r); if (arr.length) { arr.forEach(fill); return path; } } catch (e) {}
  }
  return null;
}

for (let i = 0; i < items.length; i += 100) {
  const chunk = items.slice(i, i + 100).map(x => x.product_id);

  const aSrc = await tryBatch(['/v4/product/info/attributes'], chunk, it => { attrs[it.id ?? it.product_id] = it; });
  if (i === 0) console.log('attributes source:', aSrc || 'none');

  const pSrc = await tryBatch(['/v4/product/info/prices', '/v3/product/info/prices', '/v2/product/info/prices', '/v1/product/info/prices'], chunk, it => { prices[it.product_id ?? it.id] = it; });
  if (i === 0) console.log('prices source:', pSrc || 'none -> пошточно');

  const sSrc = await tryBatch(['/v2/product/info/stocks-by-warehouse/fbo', '/v2/product/info/stocks-by-warehouse/fbs'], chunk, it => { stocks[it.product_id ?? it.id] = (it.stocks || []).reduce((t, x) => t + (x.present || 0), 0); });
  if (i === 0) console.log('stocks source:', sSrc || 'none');

  console.log('fetched', Math.min(i + 100, items.length), '/', items.length);
}

// если пакетные цены не ответили — пошточно через /v2/product/info
if (!Object.keys(prices).length) {
  for (const b of items) {
    try { const r = await ozon('/v2/product/info', { product_id: b.product_id }); const res = r.result || {}; prices[b.product_id] = res; if (!stocks[b.product_id]) stocks[b.product_id] = (res.stocks || []).reduce((t, x) => t + (x.present || 0), 0); } catch (e) {}
  }
  console.log('prices fallback: per-product /v2/product/info');
}

// собираем строки
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

// upsert в Supabase
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
