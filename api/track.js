// Visitor tracking — logs page visits to Supabase via kmm_threads table.
// Visitor rows: id = "v_<iphash>", data._type = "visitor".
export const config = { runtime: 'edge' };

const SB_URL = 'https://gdpcgtxyfbttsaascomw.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcGNndHh5ZmJ0dHNhYXNjb213Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDkyMTI0NCwiZXhwIjoyMTAwNDk3MjQ0fQ.6KgaRQ4uFdKyxeYgTRhd0T-gM7FWvByR8u5VwSgR9rM';
const TABLE = 'kmm_threads';

function hashIp(s){ let h=0; for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;} return 'v_'+Math.abs(h).toString(36); }

export default async function handler(req){
  if(req.method==='OPTIONS') return new Response(null,{status:204,headers:{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS'}});
  const url = new URL(req.url);
  const rawIp = ((req.headers.get('x-forwarded-for')||'').split(',')[0].trim())||req.headers.get('x-real-ip')||'unknown';
  const country = req.headers.get('x-vercel-ip-country')||'';
  const region = decodeURIComponent(req.headers.get('x-vercel-ip-country-region')||'');
  const city = decodeURIComponent(req.headers.get('x-vercel-ip-city')||'');
  const ua = (req.headers.get('user-agent')||'').slice(0,300);
  const ref = (url.searchParams.get('ref')||req.headers.get('referer')||'').slice(0,300);
  const path_ = (url.searchParams.get('p')||'/').slice(0,200);
  const isMessaged = url.searchParams.get('m')==='1';
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const vkey = hashIp(rawIp);

  let existing = null;
  try{
    const get = await fetch(`${SB_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(vkey)}&select=data`,{
      headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY}
    });
    if(get.ok){
      const arr = await get.json();
      if(Array.isArray(arr)&&arr[0]) existing = arr[0].data;
    }
  }catch(e){}

  const visits = (existing?.visits||0)+1;
  const paths = existing?.paths||[];
  paths.push({p:path_,t:now});
  if(paths.length>20) paths.splice(0,paths.length-20);
  const referrers = existing?.referrers||[];
  if(ref && !referrers.includes(ref)){ referrers.push(ref); if(referrers.length>10) referrers.shift(); }
  const record = Object.assign({}, existing||{}, {
    id:vkey, _type:'visitor', ip:rawIp, country, region, city, ua,
    visits, first_seen:existing?.first_seen||now, last_seen:now, last_path:path_,
    paths, referrers,
    messaged: existing?.messaged||isMessaged||false,
    last_messaged: (existing?.messaged||isMessaged) ? (existing?.last_messaged||now) : existing?.last_messaged
  });

  try{
    await fetch(`${SB_URL}/rest/v1/${TABLE}`,{
      method:'POST',
      headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'content-type':'application/json','prefer':'resolution=merge-duplicates,return=minimal'},
      body: JSON.stringify({id:vkey, data:record, updated_at:nowIso})
    });
  }catch(e){}

  // 1x1 transparent GIF
  const bin = atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return new Response(bytes,{status:200,headers:{
    'content-type':'image/gif','cache-control':'no-store','access-control-allow-origin':'*'
  }});
}
