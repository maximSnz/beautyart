// Пробная сверка Ozon Performance API (реклама) с ozon_ad_spend из CSV «Продвижение». ТОЛЬКО ЧТЕНИЕ: в базу ничего не пишет.
// Репозиторий публичный — в лог только счётчики, названия полей/колонок и расхождения в процентах; рублей и SKU нет.
// Запуск: workflow ozon-ads-probe (вручную), вход DAY — день сверки (пусто — последний день с рекламой в базе).
const PERF='https://api-performance.ozon.ru';
const SB=process.env.SUPABASE_URL, SR={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const pct=(a,b)=>b===0?(a===0?'0%':'∞'):((a-b)/Math.abs(b)*100).toFixed(3)+'%';
let TOKEN='';
async function perf(path,{method='GET',body,raw}={}){
  for(let a=0;a<5;a++){
    let r,t;
    try{r=await fetch(PERF+path,{method,headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json',Accept:'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
      t=raw?Buffer.from(await r.arrayBuffer()):await r.text();}catch(e){await sleep(2000*(a+1));continue;}
    if(r.status===429||r.status>=500){await sleep(3000*(a+1));continue;}
    let j=null;if(!raw)try{j=JSON.parse(t);}catch(e){}
    return {status:r.status,json:j,text:raw?null:t,buf:raw?t:null,type:r.headers.get('content-type')||''};
  }
  return {status:0,json:null,text:'нет ответа'};
}
const shape=(o,p='',acc=new Map())=>{if(Array.isArray(o)){acc.set(p+'[]','array');o.slice(0,50).forEach(x=>shape(x,p+'[]',acc));}else if(o&&typeof o==='object')for(const k of Object.keys(o))shape(o[k],p?p+'.'+k:k,acc);else if(!acc.has(p))acc.set(p,o===null?'null':typeof o);return acc;};
const printShape=(t,o)=>{console.log(t);[...shape(o).entries()].forEach(([k,v])=>console.log('  '+k+': '+v));};

// 1. Токен
const tk=await fetch(PERF+'/api/client/token',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
  body:JSON.stringify({client_id:process.env.OZON_PERF_CLIENT_ID,client_secret:process.env.OZON_PERF_CLIENT_SECRET,grant_type:'client_credentials'})});
const tj=await tk.json().catch(()=>({}));
console.log('Токен: HTTP',tk.status,tj.access_token?`получен, действует ${tj.expires_in} с`:(tj.error_description||tj.error||tj.message||''));
if(!tj.access_token)process.exit(1);
TOKEN=tj.access_token;

// 2. День сверки — последний день с рекламой в базе (CSV)
let D=process.env.DAY||'';
if(!D){const r=await fetch(`${SB}/rest/v1/ozon_ad_spend?select=spend_date&order=spend_date.desc&limit=1`,{headers:SR});D=(await r.json())[0]?.spend_date;}
console.log('День сверки:',D);

// 3. Кампании
const cr=await perf('/api/client/campaign');
console.log('\n/api/client/campaign: HTTP',cr.status,cr.json?'':String(cr.text).slice(0,150));
const camps=cr.json?.list||[];
if(camps.length){printShape('Устройство кампании:',camps[0]);
  const by={};camps.forEach(c=>{const k=`${c.advObjectType||'?'} / ${c.state||'?'} / ${c.paymentType||c.placement||'?'}`;by[k]=(by[k]||0)+1;});
  console.log('Кампаний',camps.length,'— тип / состояние / оплата:');Object.entries(by).forEach(([k,v])=>console.log('  '+k+': '+v));}

// 3б. Разбор отказа (12.11.2026): FORBID=1 — как ночная загрузка: кампании с расходом за DAY−1…DAY, отчёт по SKU пачками по 10,
// пачка с отказом — по одной; по кампаниям с отказом — тип, состояние, размещение, число товаров, что отдают другие методы. Только чтение.
if(process.env.FORBID==='1'){
  const add=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
  const D0=add(D,-1);
  const ex=await perf(`/api/client/statistics/expense?dateFrom=${D0}&dateTo=${D}`);
  const ids=[...new Set(String(ex.text||'').split('\n').slice(1).map(l=>l.split(';')).filter(c=>c.length>3&&Number(String(c[3]).replace(',','.'))>0).map(c=>String(c[0]).trim()))];
  console.log(`\n[FORBID] период ${D0}…${D}, кампаний с расходом ${ids.length}`);
  const batches=[];for(let i=0;i<ids.length;i+=10)batches.push(ids.slice(i,i+10));const bad=[];
  while(batches.length){const b=batches.shift();
    const r=await perf('/api/client/statistics',{method:'POST',body:{campaigns:b,dateFrom:D0,dateTo:D,groupBy:'DATE'}});
    if(r.status===200)continue;
    console.log(`  пачка из ${b.length}: HTTP ${r.status} ${String(r.text).slice(0,160)}`);
    if(b.length>1)batches.unshift(...b.map(x=>[x]));else bad.push(b[0]);}
  console.log(`[FORBID] кампаний с отказом: ${bad.length}`);
  const byId=new Map(camps.map(c=>[String(c.id),c]));
  for(const id of bad){const c=byId.get(id);
    console.log(`  кампания …${id.slice(-3)}: ${c?`тип ${c.advObjectType}, состояние ${c.state}, оплата ${c.PaymentType||'?'}, размещение ${JSON.stringify(c.placement)}, режим ${c.productCampaignMode||'?'}, автосоздана ${c.isAutocreated}, с ${c.fromDate||'?'} по ${c.toDate||'?'}`:'НЕТ в списке /api/client/campaign'}`);
    for(const d of [D0,D]){const one=await perf('/api/client/statistics',{method:'POST',body:{campaigns:[id],dateFrom:d,dateTo:d,groupBy:'DATE'}});console.log(`    отчёт по SKU за ${d} отдельно: HTTP ${one.status} ${one.status===200?'':String(one.text).slice(0,120)}`);}
    const pr=await perf(`/api/client/campaign/${id}/v2/products`);console.log(`    товары кампании (v2/products): HTTP ${pr.status}, товаров ${pr.json?.products?.length??'?'}`);
    const sp=await perf(`/api/client/campaign/${id}/search_promo/products`);if(sp.status!==404)console.log(`    товары (search_promo/products): HTTP ${sp.status}, ${String(sp.text||'').slice(0,80).replace(/\d{5,}/g,'…')}`);
    const dl=await perf(`/api/client/statistics/daily?campaignIds=${id}&dateFrom=${D0}&dateTo=${D}`);console.log(`    statistics/daily: HTTP ${dl.status}, строк ${String(dl.text||'').split('\n').length-1}`);
  }
  // есть ли расход «оплаты за заказ» (SEARCH_PROMO) уже в начислениях (ozon_charges) — тогда в рекламу его добавлять нельзя (задвоение)
  const promoIds=new Set(camps.filter(c=>c.advObjectType==='SEARCH_PROMO').map(c=>String(c.id)));
  let promoExp=0;String(ex.text||'').split('\n').slice(1).forEach(l=>{const c=l.split(';');if(c.length>3&&promoIds.has(String(c[0]).trim()))promoExp+=Number(String(c[3]).replace(',','.'))||0;});
  const ch=[];for(const d of [D0,D])for(let off=0;;off+=1000){const r=await fetch(`${SB}/rest/v1/ozon_charges?charge_date=eq.${d}&select=row_key,offer_id,charge_type,group_name,amount&order=row_key&limit=1000&offset=${off}`,{headers:SR});const j=await r.json();if(!Array.isArray(j)){console.log('  ozon_charges: ошибка',JSON.stringify(j).slice(0,120));break;}ch.push(...j);if(j.length<1000)break;}
  const t={};ch.forEach(x=>{const k=`${x.group_name||'?'} / ${x.charge_type}`;t[k]=t[k]||{n:0,s:0,noOffer:0};t[k].n++;t[k].s+=Number(x.amount||0);if(!x.offer_id)t[k].noOffer++;});
  console.log(`\n[FORBID] начисления ${D0}…${D}: строк ${ch.length}; расход SEARCH_PROMO по statistics/expense ${promoExp>0?'есть':'0'}`);
  Object.entries(t).filter(([k])=>/продвиж|реклам|заказ|promo/i.test(k)).forEach(([k,v])=>console.log(`  ${k}: строк ${v.n}, без артикула ${v.noOffer}, сумма к расходу SEARCH_PROMO ${promoExp?(Math.abs(v.s)/promoExp*100).toFixed(1)+'%':'—'}`));
  console.log('Готово. В базу ничего не записано.');process.exit(0);
}

// 4. Расходы за день по кампаниям
for(const path of [`/api/client/statistics/expense?dateFrom=${D}&dateTo=${D}`,`/api/client/statistics/daily?dateFrom=${D}&dateTo=${D}`]){
  const r=await perf(path);console.log(`\n${path.split('?')[0]}: HTTP ${r.status}, ${r.type}`);
  if(r.status===200){const t=r.json?JSON.stringify(r.json):r.text;const lines=String(t).split('\n');console.log('  первая строка (заголовок):',lines[0].slice(0,300));console.log('  строк:',lines.length);}
  else console.log('  ',String(r.text||'').slice(0,200));
}

// 5. Статистика по товарам (SKU) — отчёт по кампаниям за день (асинхронно, до 10 кампаний за запрос)
const db=await (await fetch(`${SB}/rest/v1/ozon_ad_spend?spend_date=eq.${D}&select=offer_id,amount&order=offer_id&limit=5000`,{headers:SR})).json();
const dbSku={};let dbSum=0;db.forEach(x=>{dbSku[x.offer_id]=(dbSku[x.offer_id]||0)+Number(x.amount);dbSum+=Number(x.amount);});
console.log(`\nВ базе (CSV) за день: SKU ${Object.keys(dbSku).length}`);
// только кампании с расходом за день (быстрый метод statistics/expense) — отчёты по SKU Ozon формирует в очереди, все подряд — слишком долго
const ex=await perf(`/api/client/statistics/expense?dateFrom=${D}&dateTo=${D}`);
const spent=new Set();String(ex.text||'').split('\n').slice(1).forEach(l=>{const c=l.split(';');if(c.length>3&&Number(String(c[3]).replace(',','.'))>0)spent.add(String(c[0]).trim());});
const ids=camps.map(c=>String(c.id)).filter(id=>spent.has(id));
console.log(`Кампаний с расходом за день: ${ids.length} из ${camps.length}`);
{const tp=new Map(camps.map(c=>[String(c.id),c.advObjectType||'?']));const sumT={};let tot=0;
 String(ex.text||'').split('\n').slice(1).forEach(l=>{const c=l.split(';');if(c.length<4)return;const v=Number(String(c[3]).replace(',','.'))||0;tot+=v;const t=tp.get(String(c[0]).trim())||'нет в списке кампаний';sumT[t]=(sumT[t]||0)+v;});
 console.log('Расход за день по типам кампаний (доля):',Object.entries(sumT).map(([k,v])=>k+' '+(tot?(v/tot*100).toFixed(1):0)+'%').join(', '));}
const apiSku={};let reports=0,fails=0,heads=new Set(),typesSeen={};
for(let i=0;i<ids.length;i+=10){
  const part=ids.slice(i,i+10);
  const r=await perf('/api/client/statistics',{method:'POST',body:{campaigns:part,dateFrom:D,dateTo:D,groupBy:'DATE'}});
  const uuid=r.json?.UUID||r.json?.uuid;
  if(!uuid){fails++;if(fails<3)console.log('  statistics: HTTP',r.status,String(r.text).slice(0,200));continue;}
  let st='';for(let k=0;k<40;k++){await sleep(3000);const s=await perf(`/api/client/statistics/${uuid}`);st=s.json?.state;if(st==='OK'||st==='ERROR')break;}
  if(st!=='OK'){fails++;console.log('  отчёт не готов:',st);continue;}
  const rep=await perf(`/api/client/statistics/report?UUID=${uuid}`,{raw:true});reports++;
  let txt=rep.buf.toString('utf8');
  if(rep.buf[0]===0x50&&rep.buf[1]===0x4b){console.log('  отчёт — ZIP (несколько кампаний), разбираю');
    const {execSync}=await import('node:child_process');const fs=await import('node:fs');fs.writeFileSync('/tmp/rep.zip',rep.buf);execSync('rm -rf /tmp/rep && mkdir -p /tmp/rep && cd /tmp/rep && unzip -o -q ../rep.zip');
    txt=fs.readdirSync('/tmp/rep').map(f=>fs.readFileSync('/tmp/rep/'+f,'utf8')).join('\n');}
  // CSV: строки «;», заголовок содержит «SKU» и «Расход»
  txt.split('\n').forEach(line=>{
    const c=line.split(';');if(c.length<3)return;
    if(c.some(x=>/sku/i.test(x))&&c.some(x=>/расход/i.test(x))){heads.add(c.join(' | ').slice(0,400));return;}
  });
  let hdr=null;
  txt.split('\n').forEach(line=>{const c=line.split(';').map(s=>s.replace(/^"|"$/g,'').trim());
    if(c.some(x=>/^sku$/i.test(x))&&c.some(x=>/расход/i.test(x))){hdr=c;return;}
    if(!hdr||c.length!==hdr.length)return;
    const sku=c[hdr.findIndex(x=>/^sku$/i.test(x))];const amt=Number(String(c[hdr.findIndex(x=>/^расход/i.test(x))]).replace(/\s/g,'').replace(',','.'));
    if(/^\d+$/.test(sku)&&Number.isFinite(amt))apiSku[sku]=(apiSku[sku]||0)+amt;});
}
console.log(`\nОтчётов по кампаниям: ${reports}, не получено: ${fails}`);
console.log('Заголовки отчётов:');[...heads].slice(0,3).forEach(h=>console.log('  '+h));
let same=0,diff=0,onlyA=0,onlyB=0,sa=0;
new Set([...Object.keys(apiSku),...Object.keys(dbSku)]).forEach(k=>{const a=apiSku[k],b=dbSku[k];sa+=a||0;
  if(a==null)onlyB++;else if(b==null)onlyA++;else if(Math.abs(a-b)>0.05)diff++;else same++;});
const tails=[];new Set([...Object.keys(apiSku),...Object.keys(dbSku)]).forEach(k=>{const a=apiSku[k],b=dbSku[k];if(a==null||b==null||Math.abs(a-b)>0.05)tails.push(`…${k.slice(-3)} ${a==null?'нет в API':b==null?'нет в CSV':'API '+pct(a,b)}`);});
if(tails.length)console.log('Несошедшиеся SKU (последние 3 цифры):',tails.join('; '));
console.log(`Сверка по SKU за ${D}: итог API ${pct(sa,dbSum)} к CSV; SKU совпало ${same}, другая сумма ${diff}, только в API ${onlyA}, только в CSV ${onlyB}`);
console.log('Готово. В базу ничего не записано.');
