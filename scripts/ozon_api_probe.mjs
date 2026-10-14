// Разовая проверка методов Ozon API для закупок: кластеры/склады и спрос по кластерам.
// Только чтение. Репозиторий публичный — печатаем структуру ответов (поля, типы, количество строк),
// без значений; исключение — названия кластеров и складов (география Ozon, не наши данные).
const OZON='https://api-seller.ozon.ru';
const H={ 'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json' };
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function call(path,body){
  for(let attempt=1;attempt<=6;attempt++){
    const r=await fetch(OZON+path,{method:'POST',headers:H,body:JSON.stringify(body)});
    if(r.status===429){ await sleep(5000*attempt); continue; }
    const text=await r.text(); let json=null; try{ json=JSON.parse(text); }catch(e){}
    return {status:r.status,json,text};
  }
  return {status:429,json:null,text:'429 after retries'};
}
const PUBLIC=/^(cluster_name|warehouse_name|macrolocal_cluster_name|type|cluster_type)$/;
// схема: ключ -> тип; у массивов длина и схема объединения элементов; значения скрыты
function schema(v,key='',depth=0,out=[],pad=''){
  if(Array.isArray(v)){
    out.push(`${pad}${key}: array[${v.length}]`);
    const keys=new Map(); v.slice(0,200).forEach(it=>{ if(it&&typeof it==='object'&&!Array.isArray(it)) Object.entries(it).forEach(([k,x])=>{ if(!keys.has(k)) keys.set(k,x); }); });
    if(keys.size) keys.forEach((x,k)=>schema(x,k,depth+1,out,pad+'  '));
    else if(v.length) out.push(`${pad}  [элементы]: ${typeof v[0]}`);
  } else if(v&&typeof v==='object'){
    out.push(`${pad}${key||'(ответ)'}: object`);
    Object.entries(v).forEach(([k,x])=>schema(x,k,depth+1,out,pad+'  '));
  } else out.push(`${pad}${key}: ${v===null?'null':typeof v}${PUBLIC.test(key)&&typeof v==='string'?` (например «${v}»)`:''}`);
  return out;
}
function report(title,res){
  console.log(`\n===== ${title} → HTTP ${res.status}`);
  if(res.status!==200){ console.log((res.text||'').slice(0,600)); return; }
  console.log(schema(res.json).slice(0,120).join('\n'));
}

// 1. Кластеры и склады
const WH_MAP=(await import('node:fs')).readFileSync(new URL('./ozon_to_supabase.mjs',import.meta.url),'utf8');
const known=new Set([...WH_MAP.matchAll(/'(\d+)':\['[^']*','[^']*'\]/g)].map(m=>m[1]));
for(const cluster_type of ['CLUSTER_TYPE_OZON','CLUSTER_TYPE_CIS']){
  const res=await call('/v1/cluster/list',{cluster_type,cluster_ids:[]});
  report(`/v1/cluster/list ${cluster_type}`,res);
  const clusters=res.json?.clusters||[];
  let total=0,missing=[];
  clusters.forEach(c=>{
    const whs=(c.logistic_clusters||[]).flatMap(l=>l.warehouses||[]);
    total+=whs.length;
    console.log(`  кластер «${c.name}» (id ${c.id}): складов ${whs.length}`);
    whs.forEach(w=>{ if(!known.has(String(w.warehouse_id))) missing.push(`${c.name}: ${w.name} (${w.warehouse_id})`); });
  });
  console.log(`  итого кластеров ${clusters.length}, складов ${total}; нет в справочнике WH синхронизации: ${missing.length}`);
  missing.slice(0,80).forEach(m=>console.log('    - '+m));
}

// 2. SKU для методов аналитики (первые 20 товаров)
const pl=await call('/v3/product/list',{filter:{visibility:'ALL'},limit:20,last_id:''});
const pids=(pl.json?.result?.items||[]).map(i=>i.product_id);
const info=await call('/v3/product/info/list',{product_id:pids});
const skus=[...new Set((info.json?.items||[]).flatMap(i=>[i.sku,...(i.sources||[]).map(s=>s.sku)]).filter(Boolean))].slice(0,20);
console.log(`\nSKU для проверки: ${skus.length} шт.`);

// 3. Кандидаты на спрос по кластерам
report('/v1/analytics/stocks',await call('/v1/analytics/stocks',{skus}));
report('/v1/analytics/manage/stocks',await call('/v1/analytics/manage/stocks',{limit:20,offset:0}));
report('/v2/analytics/stock_on_warehouses',await call('/v2/analytics/stock_on_warehouses',{limit:20,offset:0,warehouse_type:'ALL'}));
report('/v1/analytics/turnover/stocks',await call('/v1/analytics/turnover/stocks',{limit:20,offset:0}));
