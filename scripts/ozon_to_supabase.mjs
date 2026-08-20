const OZON = 'https://api-seller.ozon.ru';
const h = { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY, 'Content-Type': 'application/json' };
const ozon = async (path, body) => {
  const r = await fetch(OZON + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
};

// 1) все товары (пагинация)
let items = [], last_id = '';
do {
  const r = await ozon('/v3/product/list', { filter: {}, limit: 1000, last_id });
  items = items.concat(r.result?.items || []);
  last_id = r.result?.last_id || '';
} while (last_id);
console.log('total products:', items.length);

// 2) детали пачками по 100
const map = it => ({
  product_id: it.product_id,
  offer_id: it.offer_id ?? '',
  name: it.name ?? '',
  price: Number(it.price ?? it.marketing_price ?? 0),
  stock: (it.stocks || []).reduce((s, x) => s + (x.present || 0), 0),
  visibility: it.visibility ?? '',
  raw: it,
  updated_at: new Date().toISOString()
});
const rows = [];
for (let i = 0; i < items.length; i += 100) {
  const chunk = items.slice(i, i + 100).map(x => x.product_id);
  const r = await ozon('/v3/product/info/list', { product_id: chunk });
  (r.result?.items || []).forEach(it => rows.push(map(it)));
  console.log('fetched', Math.min(i + 100, items.length), '/', items.length);
}

// 3) upsert в Supabase
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
