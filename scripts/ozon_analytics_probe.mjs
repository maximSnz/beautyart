// Проба API Ozon для аналитики товара (рабочий стол 2 окна товара, этап 5). ТОЛЬКО ЧТЕНИЕ: в базу ничего не пишет.
// Вопросы: 1) какие метрики воронки по нашим товарам отдаёт /v1/analytics/data (часть — только с подпиской Premium);
// 2) есть ли в API данные о конкурентах (как отчёт «Аналитика рынка» кабинета); 3) цены конкурентов — ценовой индекс;
// 4) объём товара, акции.
// Репозиторий публичный — в лог идут только статусы, устройство ответов, счётчики и доли; рублей, штук, артикулов нет.
const OZON='https://api-seller.ozon.ru';
const H={'Client-Id':process.env.OZON_CLIENT_ID,'Api-Key':process.env.OZON_API_KEY,'Content-Type':'application/json'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ozon(path,body,method='POST'){
  for(let a=0;a<4;a++){
    const r=await fetch(OZON+path,method==='GET'?{headers:H}:{method,headers:H,body:JSON.stringify(body)});
    const t=await r.text(); let j=null; try{j=JSON.parse(t);}catch(e){}
    if(r.status===429||r.status>=500){await sleep(20000*(a+1));continue;}
    return {status:r.status,json:j,text:j?null:t.slice(0,200)};
  }
  return {status:0,json:null,text:'нет ответа'};
}
const msg=r=>r.status+' '+String(r.json?.message||r.text||'').slice(0,200);
function shape(o,p='',acc=new Map()){
  const add=(k,t)=>{const s=acc.get(k)||new Set();s.add(t);acc.set(k,s);};
  if(Array.isArray(o)){add(p+'[]','array'); o.slice(0,50).forEach(x=>shape(x,p+'[]',acc));}
  else if(o&&typeof o==='object'){for(const k of Object.keys(o))shape(o[k],p?p+'.'+k:k,acc);}
  else add(p,o===null?'null':typeof o);
  return acc;
}
const printShape=(title,acc)=>{console.log(title);[...acc.keys()].sort().forEach(k=>console.log('  '+k+': '+[...acc.get(k)].join('|')));};
const day=(n)=>{const d=new Date(Date.now()+3*3600e3);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const from=day(-7), to=day(-1);
console.log(`Период: ${from} … ${to}`);

// 1. Воронка по нашим товарам. Метод — не чаще 1 раза в минуту, поэтому пачками с паузой.
const M1=['hits_view','hits_view_search','hits_view_pdp','hits_tocart','hits_tocart_search','hits_tocart_pdp','session_view','session_view_search','session_view_pdp','conv_tocart','conv_tocart_search','conv_tocart_pdp','ordered_units','revenue'];
const M2=['returns','cancellations','delivered_units','position_category','adv_view_pdp','adv_view_search_category','adv_view_all','adv_sum_all'];
async function analytics(metrics,dimension){
  const r=await ozon('/v1/analytics/data',{date_from:from,date_to:to,metrics,dimension,filters:[],sort:[{key:metrics[0],order:'DESC'}],limit:1000,offset:0});
  if(r.status!==200){console.log(`  [${dimension}] ${metrics.length} метрик: HTTP ${msg(r)}`);return null;}
  const rows=r.json?.result?.data||[];
  console.log(`  [${dimension}] строк ${rows.length}; поля ответа result: ${Object.keys(r.json?.result||{}).join(', ')}`);
  metrics.forEach((m,i)=>{const nz=rows.filter(x=>Number(x.metrics?.[i])>0).length;console.log(`    ${m}: непустых ${nz} из ${rows.length}`);});
  return rows;
}
console.log('\n1. /v1/analytics/data — воронка наших товаров');
let ok1=await analytics(M1,['sku']);
await sleep(65000);
let ok2=await analytics(M2,['sku']);
// при отказе пачки — по одной метрике, чтобы понять, какие недоступны
for(const [ok,ms] of [[ok1,M1],[ok2,M2]]){ if(ok) continue;
  for(const m of ms){await sleep(65000);await analytics([m],['sku']);} }
await sleep(65000);
console.log('  по дням (sku + day), 4 метрики:');
const dd=await analytics(['hits_view','hits_view_pdp','hits_tocart','ordered_units'],['sku','day']);
if(dd)console.log(`    различных дней в ответе: ${new Set(dd.map(x=>x.dimensions?.[1]?.id)).size}`);

// 2. Данные о рынке / конкурентах — проверяем, есть ли такие методы вообще (статус ответа).
console.log('\n2. Методы рынка и конкурентов (статус ответа; 404 — метода нет)');
const probes=[
  ['/v1/analytics/product-queries',{date_from:from+'T00:00:00Z',date_to:to+'T23:59:59Z',skus:[],page:0,page_size:10}],
  ['/v1/analytics/product-queries/details',{date_from:from+'T00:00:00Z',date_to:to+'T23:59:59Z',skus:[],page:0,page_size:10,limit_by_sku:5}],
  ['/v1/search-queries/top',{limit:'5',offset:'0'}],
  ['/v1/search-queries/text',{text:'бахилы',limit:'5',offset:'0'}],
  ['/v1/pricing-strategy/competitors/list',{page:1,limit:20}],
  ['/v1/analytics/competitors',{}],
  ['/v1/analytics/market',{}],
  ['/v1/analytics/category',{}],
];
for(const [p,b] of probes){const r=await ozon(p,b);
  console.log(`  ${p}: HTTP ${msg(r)}`);
  if(r.status===200&&r.json)printShape('    устройство ответа:',shape(r.json));
  await sleep(1500);}

// 3. Ценовой индекс: минимальные цены такого же товара у других продавцов Ozon и на других площадках.
console.log('\n3. /v5/product/info/prices — ценовой индекс');
{const r=await ozon('/v5/product/info/prices',{filter:{visibility:'ALL'},limit:100,cursor:''});
 if(r.status!==200)console.log('  HTTP',msg(r)); else {const it=r.json?.items||[];
  const pi=it.map(x=>x.price_indexes||{});
  printShape('  устройство price_indexes:',shape(pi.slice(0,5)));
  for(const k of ['external_index_data','ozon_index_data','self_marketplaces_index_data']){
    const nz=pi.filter(x=>Number(x[k]?.min_price)>0).length; console.log(`  ${k}.min_price > 0: ${nz} из ${it.length}`);}
  const col={};pi.forEach(x=>{col[x.color_index]=(col[x.color_index]||0)+1;});console.log('  color_index:',JSON.stringify(col));}}

// 4. Объём (габариты) и акции.
console.log('\n4. Габариты и акции');
{const r=await ozon('/v4/product/info/attributes',{filter:{visibility:'ALL'},limit:5});
 if(r.status!==200)console.log('  attributes HTTP',msg(r)); else {const x=(r.json?.result||[])[0]||{};
  console.log('  поля товара с габаритами:',['depth','width','height','dimension_unit','weight','weight_unit'].filter(k=>k in x).join(', ')||'нет');}}
{const r=await ozon('/v1/actions',null,'GET');
 if(r.status!==200)console.log('  /v1/actions HTTP',msg(r)); else {const a=r.json?.result||[];console.log(`  /v1/actions: акций ${a.length}, участвуем (participating_products_count>0): ${a.filter(x=>x.participating_products_count>0).length}`);}}

console.log('\nГотово. В базу ничего не записано.');
