const OZON='https://api-seller.ozon.ru';
const H={ 'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json' };
async function ozon(path,body){
  const r=await fetch(OZON+path,{method:'POST',headers:H,body:JSON.stringify(body)});
  if(!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}
const asArr=r=>Array.isArray(r?.result)?r.result:(r?.result?.items||[]);

let items=[],last_id='';
do{ const r=await ozon('/v3/product/list',{filter:{},limit:1000,last_id}); items=items.concat(r.result?.items||[]); last_id=r.result?.last_id||''; }while(last_id);
console.log('total products:',items.length);

const attrs={},prices={},stocks={},stocksOffer={};
async function tryBatch(paths,chunk,fill){
  for(const path of paths){
    try{ const r=await ozon(path,{filter:{product_id:chunk,offer_id:[],visibility:'ALL'},last_id:'',limit:1000}); const arr=asArr(r); if(arr.length){arr.forEach(fill);return path;} }catch(e){}
  }
  return null;
}

// атрибуты пачками по 100
for(let i=0;i<items.length;i+=100){
  const chunk=items.slice(i,i+100).map(x=>x.product_id);
  await tryBatch(['/v4/product/info/attributes'],chunk,it=>{attrs[it.id??it.product_id]=it;});
}

// остатки FBO мелкими пачками по 20 артикулов (метод режет на 1000 строк)
const offersAll=items.map(x=>x.offer_id).filter(Boolean);
let fboRows=0;
for(let i=0;i<offersAll.length;i+=20){
  const of=offersAll.slice(i,i+20);
  const r=await ozon('/v1/product/info/stocks-by-warehouse/fbo',{offer_ids:of,last_id:'',limit:1000});
  const list=r.products||[];
  fboRows+=list.length;
  if(list.length>=1000)console.log('WARNING: truncated at offset',i);
  list.forEach(it=>{
    const s=it.present||0;
    if(it.product_id!=null) stocks[it.product_id]=(stocks[it.product_id]||0)+s;
    if(it.offer_id) stocksOffer[it.offer_id]=(stocksOffer[it.offer_id]||0)+s;
  });
}
console.log('fbo rows total:',fboRows,'| stocks source: /v1/.../fbo (chunks of 20)');

// цены пошточно + остатки как запасной
for(const b of items){
  try{
    const r=await ozon('/v2/product/info',{product_id:b.product_id});
    const res=r.result||{}; prices[b.product_id]=res;
    if(stocks[b.product_id]==null&&stocksOffer[b.offer_id]==null) stocks[b.product_id]=(res.stocks||[]).reduce((t,x)=>t+(x.present||0),0);
  }catch(e){}
}
console.log('prices source: per-product /v2/product/info');

const rows=items.map(b=>{
  const a=attrs[b.product_id]||{}, p=prices[b.product_id]||{};
  return { product_id:b.product_id, offer_id:a.offer_id??b.offer_id??'', name:a.name??'', price:Number(p.price??0), stock:stocks[b.product_id]??stocksOffer[b.offer_id]??0, visibility:a.visibility??'', raw:a, updated_at:new Date().toISOString() };
});
console.log('TOTAL FBO stock:',rows.reduce((s,r)=>s+(r.stock||0),0));

if(rows.length){
  const up=await fetch(`${process.env.SUPABASE_URL}/rest/v1/products?on_conflict=product_id`,{
    method:'POST',
    headers:{ apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates' },
    body:JSON.stringify(rows)
  });
  if(!up.ok) throw new Error(`supabase -> HTTP ${up.status}: ${await up.text()}`);
}
console.log('synced to Supabase:',rows.length,'products');
