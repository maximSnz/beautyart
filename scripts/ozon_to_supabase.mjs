const OZON='https://api-seller.ozon.ru';
const H={ 'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json' };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ozon(path,body){
  for(let attempt=1;attempt<=6;attempt++){
    const r=await fetch(OZON+path,{method:'POST',headers:H,body:JSON.stringify(body)});
    if(r.status===429){ await sleep(1000*attempt); continue; }
    if(!r.ok) throw new Error(`${path} -> HTTP ${r.status}: ${await r.text()}`);
    return r.json();
  }
  throw new Error(`${path} -> 429 after retries`);
}
const asArr=r=>Array.isArray(r?.result)?r.result:(r?.result?.items||[]);

// === МАППИНГ СКЛАДОВ (ID -> город). Дополняйте по мере сопоставления. ===
const WH_NAMES={
  '1020000115166000':'Москва',
  '1020000241710000':'Ростов-на-Дону',
  '1020000267736000':'Казань',
};
const whName=id=>WH_NAMES[String(id)]||('wh_'+id);

let items=[],last_id='';
do{ const r=await ozon('/v3/product/list',{filter:{},limit:1000,last_id}); items=items.concat(r.result?.items||[]); last_id=r.result?.last_id||''; }while(last_id);
console.log('total products:',items.length);

const attrs={},prices={};
async function tryBatch(paths,chunk,fill){
  for(const path of paths){
    try{ const r=await ozon(path,{filter:{product_id:chunk,offer_id:[],visibility:'ALL'},last_id:'',limit:1000}); const arr=asArr(r); if(arr.length){arr.forEach(fill);return path;} }catch(e){}
  }
  return null;
}
for(let i=0;i<items.length;i+=100){
  const chunk=items.slice(i,i+100).map(x=>x.product_id);
  await tryBatch(['/v4/product/info/attributes'],chunk,it=>{attrs[it.id??it.product_id]=it;});
  await sleep(300);
}

const offersAll=items.map(x=>x.offer_id).filter(Boolean);
const byProduct=new Map();
const whTotals={};
for(let i=0;i<offersAll.length;i+=20){
  const of=offersAll.slice(i,i+20);
  const r=await ozon('/v1/product/info/stocks-by-warehouse/fbo',{offer_ids:of,last_id:'',limit:1000});
  (r.products||[]).forEach(it=>{
    const pid=it.product_id; if(pid==null)return;
    whTotals[it.warehouse_id]=(whTotals[it.warehouse_id]||0)+(it.present||0);
    if(!byProduct.has(pid))byProduct.set(pid,[]);
    byProduct.get(pid).push({warehouse_name:whName(it.warehouse_id),present:it.present||0});
  });
  await sleep(400);
}
// список всех складов с суммарным остатком (для сопоставления с городами)
console.log('DISTINCT WAREHOUSES:',Object.entries(whTotals).sort((a,b)=>b[1]-a[1]).map(([id,t])=>`${id}:${t}`).join(', '));

for(const b of items){
  try{ const r=await ozon('/v2/product/info',{product_id:b.product_id}); prices[b.product_id]=r.result||{}; }catch(e){}
  await sleep(150);
}

const rows=items.map(b=>{
  const a=attrs[b.product_id]||{}, p=prices[b.product_id]||{};
  const sumStock=(byProduct.get(b.product_id)||[]).reduce((s,x)=>s+x.present,0);
  return { product_id:b.product_id, offer_id:a.offer_id??b.offer_id??'', name:a.name??'', price:Number(p.price??0), stock:sumStock, visibility:a.visibility??'', raw:a, updated_at:new Date().toISOString() };
});
if(rows.length){
  const up=await fetch(`${process.env.SUPABASE_URL}/rest/v1/products?on_conflict=product_id`,{
    method:'POST',
    headers:{ apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates' },
    body:JSON.stringify(rows)
  });
  if(!up.ok) throw new Error(`supabase products -> HTTP ${up.status}: ${await up.text()}`);
}

const stockRows=[];
byProduct.forEach((list,pid)=>list.forEach(({warehouse_name,present})=>stockRows.push({product_id:pid,warehouse_name,present,updated_at:new Date().toISOString()})));
if(stockRows.length){
  const up=await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?on_conflict=product_id,warehouse_name`,{
    method:'POST',
    headers:{ apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates' },
    body:JSON.stringify(stockRows)
  });
  if(!up.ok) throw new Error(`supabase stocks -> HTTP ${up.status}: ${await up.text()}`);
}
console.log('synced products:',rows.length,'| stocks rows:',stockRows.length);
