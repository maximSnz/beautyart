// Ночная синхронизация карточек WB → wb_products (база ИП). Строка = размер карточки (chrt_id).
// Пишет только поля WB (nm_id, артикул продавца, размер, ШК, название, предмет, бренд, wb_archived);
// поля закупки (поставщик, НДС, ЧЗ, в коробе, на паллете) и себестоимость не трогает — их ведёт wb-products.html.
// Репозиторий публичный: в лог — только количества.
const T = process.env.WB_API_TOKEN, SB = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!T || !SB || !KEY) throw new Error('нет секретов WB_API_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
const SR = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wb(body) {
  for (let a = 1; a <= 5; a++) {
    const r = await fetch('https://content-api.wildberries.ru/content/v2/get/cards/list', { method: 'POST', headers: { Authorization: T, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) { await sleep(10000 * a); continue; }
    if (!r.ok) throw new Error(`WB cards/list -> HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
  throw new Error('WB cards/list -> 429 после повторов');
}

// 1) все карточки (постранично по курсору updatedAt + nmID)
const cards = []; let cursor = { limit: 100 };
for (;;) {
  const j = await wb({ settings: { cursor, filter: { withPhoto: -1 } } });
  const page = j.cards || []; cards.push(...page);
  if (page.length < cursor.limit) break;
  cursor = { limit: 100, updatedAt: j.cursor.updatedAt, nmID: j.cursor.nmID };
  await sleep(700);
}

// 2) размеры → строки
const now = new Date().toISOString(), rows = [];
for (const c of cards) for (const s of (c.sizes || [])) {
  const skus = (s.skus || []).map(String).filter(Boolean);
  rows.push({ chrt_id: s.chrtID, nm_id: c.nmID, vendor_code: c.vendorCode ?? null, tech_size: s.techSize ?? null,
    barcodes: skus, barcode: skus[0] ?? null, title: c.title ?? null, subject: c.subjectName ?? null, brand: c.brand ?? null,
    wb_archived: false, wb_updated_at: c.updatedAt ?? null, updated_at: now });
}
if (!rows.length) throw new Error('WB вернул 0 карточек — прерываю, чтобы не пометить всё архивом');

// 3) запись (merge: поля закупки не перезаписываются)
for (let i = 0; i < rows.length; i += 500) {
  const r = await fetch(`${SB}/rest/v1/wb_products?on_conflict=chrt_id`, { method: 'POST', headers: { ...SR, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows.slice(i, i + 500)) });
  if (!r.ok) throw new Error(`supabase wb_products -> HTTP ${r.status}: ${await r.text()}`);
}

// 4) размеры, которых больше нет в выдаче WB, — wb_archived
const r = await fetch(`${SB}/rest/v1/wb_products?updated_at=lt.${encodeURIComponent(now)}&wb_archived=eq.false`, { method: 'PATCH', headers: { ...SR, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ wb_archived: true }) });
if (!r.ok) throw new Error(`supabase wb_archived -> HTTP ${r.status}: ${await r.text()}`);
const gone = (await r.json()).length;

console.log(`карточек WB: ${cards.length} | размеров записано: ${rows.length} | без ШК: ${rows.filter(x => !x.barcode).length} | ушли из WB (в архив): ${gone}`);
