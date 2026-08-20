import fs from 'fs';
const HD={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'};
function parseCSV(t){const rows=[];let row=[],cur='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){cur+='"';i++;}else q=false;}else cur+=c;}else{if(c=='"')q=true;else if(c==','){row.push(cur);cur='';}else if(c=='\n'){row.push(cur);rows.push(row);row=[];cur='';}else if(c!='\r')cur+=c;}}if(cur!==''||row.length){row.push(cur);rows.push(row);}return rows.filter(r=>r.some(x=>x&&x.trim()!==''));}
function parseDate(s){s=(s||'').trim();if(!s)return null;let m=s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);if(m)return new Date(`${m[3]}-${m[2]}-${m[1]}`);const d=new Date(s);return isNaN(d)?null:d;}
const rows=parseCSV(fs.readFileSync('data/history.csv','utf8'));
const head=rows[0].map(h=>(h||'').toLowerCase());
const idx=k=>head.findIndex(h=>k.some(x=>h.includes(x)));
const iOffer=idx(['артикул','offer','article']),iCost=idx(['себест','стоим','цена','cost']),iDate=idx(['дата','date']),iSup=idx(['поставщик','supplier']),iVat=idx(['ндс','vat']),iCz=idx(['чз','честн','знак']);
console.log('columns:',{iOffer,iCost,iDate,iSup,iVat,iCz});
const products=await (await fetch(process.env.SUPABASE_URL+'/rest/v1/products?select=product_id,offer_id',{headers:HD})).json();
const byOffer={};products.forEach(p=>byOffer[(p.offer_id||'').trim()]=p.product_id);
const groups={};
for(let r=1;r<rows.length;r++){const offer=(rows[r][iOffer]||'').trim();if(!offer)continue;const pid=byOffer[offer];if(!pid)continue;(groups[offer]=groups[offer]||[]).push(rows[r]);}
console.log('matched offers:',Object.keys(groups).length,'of',products.length);
for(const offer in groups){
  const pid=byOffer[offer],list=groups[offer],last=list[list.length-1],upd={};
  if(iSup>=0&&(last[iSup]||'').trim())upd.supplier=(last[iSup]||'').trim();
  if(iVat>=0&&(last[iVat]||'').trim())upd.vat=(last[iVat]||'').trim();
  if(iCz>=0)upd.cz=/(да|1|\+|yes|true)/i.test((last[iCz]||'').trim());
  if(Object.keys(upd).length)await fetch(process.env.SUPABASE_URL+`/rest/v1/products?product_id=eq.${pid}`,{method:'PATCH',headers:{...HD,Prefer:'return=minimal'},body:JSON.stringify(upd)});
  await fetch(process.env.SUPABASE_URL+`/rest/v1/product_prices?product_id=eq.${pid}&created_by=eq.импорт`,{method:'DELETE',headers:HD});
  const revs=[];
  for(const row of list){const cost=Number(String(row[iCost]||'').replace(',','.').replace(/\s/g,''));if(!isFinite(cost)||cost<=0)continue;const d=parseDate(row[iDate]||'');revs.push({product_id:pid,cost,created_by:'импорт',created_at:(d||new Date()).toISOString()});}
  if(revs.length)await fetch(process.env.SUPABASE_URL+'/rest/v1/product_prices',{method:'POST',headers:{...HD,Prefer:'return=minimal'},body:JSON.stringify(revs)});
}
console.log('import done');
