import fs from 'fs';
const HD={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'};
function parseCSV(t){const rows=[];let row=[],cur='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){cur+='"';i++;}else q=false;}else cur+=c;}else{if(c=='"')q=true;else if(c==','){row.push(cur);cur='';}else if(c=='\n'){row.push(cur);rows.push(row);row=[];cur='';}else if(c!='\r')cur+=c;}}if(cur!==''||row.length){row.push(cur);rows.push(row);}return rows.filter(r=>r.some(x=>x&&x.trim()!==''));}
function parseDate(s){s=(s||'').trim();if(!s)return null;let m=s.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);if(m){let y=m[3];if(y.length===2)y='20'+y;return new Date(`${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);}const d=new Date(s);return isNaN(d)?null:d;}
const num=v=>{const n=Number(String(v??'').replace(/\s/g,'').replace(',','.'));return isFinite(n)?n:null;};

const rows=parseCSV(fs.readFileSync('data/history.csv','utf8'));
const head=rows[0];
const iOffer=head.findIndex(h=>/артикул|offer|article/i.test(h||''));
const iSup=2;  // колонка C
const iVat=4;  // колонка E
const iCz=head.findIndex(h=>/чз|честн|знак/i.test(h||''));
const revCols=[]; head.forEach((h,i)=>{const d=parseDate(h||''); if(d) revCols.push({i,date:d});});
console.log('article col:',iOffer,'| revision cols:',revCols.map(c=>`${c.i}:${c.date.toLocaleDateString('ru-RU')}`).join(', '));

const products=await (await fetch(process.env.SUPABASE_URL+'/rest/v1/products?select=product_id,offer_id,supplier,vat,cz',{headers:HD})).json();
const byOffer={}; products.forEach(p=>byOffer[(p.offer_id||'').trim()]=p);

let matched=0;
for(let r=1;r<rows.length;r++){
  const offer=(rows[r][iOffer]||'').trim(); if(!offer)continue;
  const cur=byOffer[offer]; if(!cur)continue; matched++;
  const pid=cur.product_id, row=rows[r];

  // ревизии цен (даты из строки 1); старые импорты перезаписываются
  await fetch(process.env.SUPABASE_URL+`/rest/v1/product_prices?product_id=eq.${pid}&created_by=eq.импорт`,{method:'DELETE',headers:HD});
  await fetch(process.env.SUPABASE_URL+`/rest/v1/product_prices?product_id=eq.${pid}&created_by=is.null`,{method:'DELETE',headers:HD});
  const revs=[];
  for(const c of revCols){const cost=num(row[c.i]); if(cost==null||cost<=0)continue; revs.push({product_id:pid,cost,created_by:null,created_at:c.date.toISOString()});}
  if(revs.length)await fetch(process.env.SUPABASE_URL+'/rest/v1/product_prices',{method:'POST',headers:{...HD,Prefer:'return=minimal'},body:JSON.stringify(revs)});

  // поставщик (C) и НДС (E): обновляем и пишем в историю ТОЛЬКО при изменении
  const upd={}, meta=[];
  const newSup=(row[iSup]||'').trim();
  if(newSup && newSup!==(cur.supplier||'')){upd.supplier=newSup; meta.push({product_id:pid,field:'supplier',value:newSup,created_by:'импорт'});}
  const newVat=(row[iVat]||'').trim();
  if(newVat && newVat!==(cur.vat||'')){upd.vat=newVat; meta.push({product_id:pid,field:'vat',value:newVat,created_by:'импорт'});}
  if(iCz>=0){const cz=/(да|1|\+|yes|true)/i.test((row[iCz]||'').trim()); if(cz!==!!cur.cz) upd.cz=cz;}
  if(Object.keys(upd).length)await fetch(process.env.SUPABASE_URL+`/rest/v1/products?product_id=eq.${pid}`,{method:'PATCH',headers:{...HD,Prefer:'return=minimal'},body:JSON.stringify(upd)});
  if(meta.length)await fetch(process.env.SUPABASE_URL+'/rest/v1/product_meta_history',{method:'POST',headers:{...HD,Prefer:'return=minimal'},body:JSON.stringify(meta)});
}
console.log('matched offers:',matched,'of',products.length);
console.log('import done');
