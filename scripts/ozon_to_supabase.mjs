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

// === Склад (ID) -> кластер (город) ===
const WH_NAMES={
 // Москва, МО и Дальние регионы
 '1020000115166000':'Москва','23843917228000':'Москва','15431806189000':'Москва','23902289166000':'Москва','1020001853819000':'Москва','1020000759116000':'Москва','1020001853757000':'Москва','1020000435290000':'Москва','1020000241710000':'Москва',
 // Ярославль
 '1020002006967000':'Ярославль',
 // Краснодар
 '102000267736000':'Краснодар','23601604393000':'Краснодар','102000311522000':'Краснодар',
 // Новосибирск
 '18044341087000':'Новосибирск','1020005006583540':'Новосибирск','1020005006580020':'Новосибирск',
 // Казань
 '23599177351000':'Казань','1020003105329000':'Казань','18044494830000':'Казань',
 // Красноярск
 '1020002690706000':'Красноярск','22296628035000':'Красноярск',
 // Саратов
 '1020000310035000':'Саратов','1020001853897000':'Саратов',
 // Ростов
 '1020003110535000':'Ростов','17717042026000':'Ростов',
 // Тверь
 '23021125185000':'Тверь',
 // Астана
 '1020000367015000':'Астана',
 // Невинномысск
 '1020001351243000':'Невинномысск',
 // Беларусь
 '23402539267000':'Беларусь',
 // Омск
 '1020001835468000':'Омск',
 // Дальний Восток
 '1020000890160000':'Дальний Восток',
 // Калининград
 '22294782253000':'Калининград',
 // Санкт-Петербург и СЗО
 '10200001649180000':'Санкт-Петербург','1020002417800000':'Санкт-Петербург','18044249781000':'Санкт-Петербург','23903599483000':'Санкт-Петербург','1020000613861000':'Санкт-Петербург',
 // Воронеж
 '23684735180000':'Воронеж','1020001007805000':'Воронеж',
 // Тюмень
 '1020002007530000':'Тюмень',
 // Екатеринбург
 '18044570445000':'Екатеринбург',
 // Пермь
 '23948599159000':'Пермь',
 // Уфа
 '1020001836298000':'Уфа',
 // Самара
 '23128509046000':'Самара',
 // Оренбург
 '1020001836200000':'Оренбург',
};

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

// остатки FBO пачками по 20, с привязкой к кластеру
const offersAll=items.map(x=>x.offer_id).filter(Boolean);
const byProduct=new Map();
const unmapped={};
for(let i=0;i<offersAll.length;i+=20){
  const of=offersAll.slice(i,i+20);
  const r=await ozon('/v1/product/info/stocks-by-warehouse/fbo',{offer_ids:of,last_id:'',limit:1000});
  (r.products||[]).forEach(it=>{
    const pid=it.product_id; if(pid==null)return;
    const name=WH_NAMES[String(it.warehouse_id)];
    if(!name) unmapped[it.warehouse_id]=(unmapped[it.warehouse_id]||0)+(it.present||0);
    if(!byProduct.has(pid))byProduct.set(pid,[]);
    byProduct.get(pid).push({warehouse_name:name||('wh_'+it.warehouse_id),present:it.present||0});
  });
  await sleep(400);
}
if(Object.keys(unmapped).length)console.log('UNMAPPED WAREHOUSES:',Object.entries(unmapped).map(([id,t])=>`${id}:${t}`).join(', '));

// цены поштучно
for(const b of items){
  try{ const r=await ozon('/v2/product/info',{product_id:b.product_id}); prices[b.product_id]=r.result||{}; }catch(e){}
  await sleep(150);
}

// товары
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

// чистим старые строки остатков (в т.ч. прежние wh_…), пишем заново
const SR={ apikey:process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` };
for(let i=0;i<items.length;i+=100){
  const pids=items.slice(i,i+100).map(x=>x.product_id).join(',');
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?product_id=in.(${pids})`,{method:'DELETE',headers:SR});
}
const stockRows=[];
byProduct.forEach((list,pid)=>list.forEach(({warehouse_name,present})=>stockRows.push({product_id:pid,warehouse_name,present,updated_at:new Date().toISOString()})));
if(stockRows.length){
  const up=await fetch(`${process.env.SUPABASE_URL}/rest/v1/product_stocks?on_conflict=product_id,warehouse_name`,{
    method:'POST',
    headers:{ ...SR, 'Content-Type':'application/json', Prefer:'resolution=merge-duplicates' },
    body:JSON.stringify(stockRows)
  });
  if(!up.ok) throw new Error(`supabase stocks -> HTTP ${up.status}: ${await up.text()}`);
}
console.log('synced products:',rows.length,'| stocks rows:',stockRows.length);
