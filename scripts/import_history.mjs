import fs from 'fs';
const HD={apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'};
function parseCSV(t){const rows=[];let row=[],cur='',q=false;for(let i=0;i<t.length;i++){const c=t[i];if(q){if(c=='"'){if(t[i+1]=='"'){cur+='"';i++;}else q=false;}else cur+=c;}else{if(c=='"')q=true;else if(c==','){row.push(cur);cur='';}else if(c=='\n'){row.push(cur);rows.push(row);row=[];cur='';}else if(c!='\r')cur+=c;}}if(cur!==''||row.length){row.push(cur);rows.push(row);}return rows.filter(r=>r.some(x=>x&&x.trim()!==''));}
// дата ищется в любом месте текста («Цена с 01.01.2026»)
function parseDate(s){s=(s||'').trim();if(!s)return null;let m=s.match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);if(m){let y=m[3];if(y.length===2)y='20'+y;return new Date(`${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);}const d=new Date(s);return isNaN(d)?null:d;}
const num=v=>{const n=Number(String(v??'').replace(/\s/g,'').replace(',','.'));return isFinite(n)?n:null;};

const rows=parseCSV(fs.readFileSync('data/history.csv','utf8'));
const head=rows[0];
const iOffer=head.findIndex(h=>/артикул|offer|article/i.test(h||''));
const iSup=head.findIndex(h=>/поставщик|supplier/i.test(h||''));
const iVat=head.findIndex(h=>/ндс|vat/i.test(h||''));
const iCz=head.findIndex(h=>/чз|честн|знак/i.test(h||''));
// колонки-ревизии = те, у которых в строке 1 дата (у вас это F:M)
const revCols=[]; head.forEach((h,i)=>{const d=parseDate(h||''); if(d) revCols.push({i,date:d});});
console.log('article col:',iOffer,'| revision cols:',revCols.map(c=>`${c.i}:${c.date.toLocaleDateString('ru-RU')}`).join(', '));

const products=await (await fetch(process.env.SUPABASE_URL+'/rest/v1/products?select=product_id,offer_id',{headers:HD})).json();
const byOffer={}; products.forEach(p=>byOffer[(p.offer_id||'').trim()]=p.product_id);

let matched=0;
for(let r=1;r<rows.length;r++){
  const offer=(rows[r][iOffer]||'').trim(); if(!offer)continue;
  const pid=byOffer[offer]; if(!pid)continue; matched++;
  const row=rows[r], upd={};
  if(iSup>=0&&(row[iSup]||'').trim())upd.supplier=(row[iSup]||'').trim();
  if(iVat>=0&&(row[iVat]||'').trim())upd.vat=(row[iVat]||'').trim();
  if(iCz>=0)upd.cz=/(да|1|\+|yes|true)/i.test((row[iCz]||'').trim());
  if(Object.keys(upd).length)await fetch(process.env.SUPABASE_URL+`/rest/v1/products?product_id=eq.${pid}`,{method:'PATCH',headers:{...HD,Prefer:'return=minimal'},body:JSON.stringify(upd)});

  // чистим старые импорты, не трогая «закупщик»
  await fetch(process.env.SUPABASE_URL+`/rest/v1/product_prices?product_id=eq.${pid}&created_by=eq.импорт`,{method:'DELETE',headers:HD});
  await fetch(process.env.SUPABASE_URL+`/rest/v1/product_prices?product_id=eq.${pid}&created_by=is.null`,{method:'DELETE',headers:HD});

  const revs=[];
  for(const c of revCols){const cost=num(row[c.i]); if(cost==null||cost<=0)continue; revs.push({product_id:pid,cost,created_by:null,created_at:c.date.toISOString()});}
  if(revs.length)await fetch(process.env.SUPABASE_URL+'/rest/v1/product_prices',{method:'POST',headers:{...HD,Prefer:'return=minimal'},body:JSON.stringify(revs)});
}
console.log('matched offers:',matched,'of',products.length);
console.log('import done');
