// Unified chat API (Supabase-backed when env vars configured; in-memory fallback).
// Set on Vercel → Environment Variables:
//   SUPABASE_URL             = https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY = eyJ... (service_role key, SECRET)
//   (optional) ADMIN_SECRET  = any random string to sign session tokens
//
// Supabase SQL to run once:
//   create table if not exists kmm_threads (
//     id text primary key,
//     data jsonb not null,
//     updated_at timestamptz default now()
//   );
//   create index if not exists kmm_threads_updated on kmm_threads(updated_at desc);
//   alter table kmm_threads enable row level security;
//
// Endpoints (JSON body POST; GET for polling):
//   POST /api/chat  { action: 'createThread'|'sendMsg'|'reply'|'markRead'|'deleteThread'|'login'|'changePassword'|'_updateContact', ... }
//   GET  /api/chat?tid=xxx                              visitor poll
//   GET  /api/chat?admin=1&token=xxx|pw=xxx             admin poll

export const config = { runtime: 'edge' };

// Supabase config — hardcoded fallback for instant zero-setup persistence.
// Server-only: never sent to browser (edge function runs on Vercel backend).
// Override via Vercel env vars SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY if needed.
const SB_URL = globalThis.process?.env?.SUPABASE_URL || globalThis.SUPABASE_URL || 'https://gdpcgtxyfbttsaascomw.supabase.co';
const SB_KEY = globalThis.process?.env?.SUPABASE_SERVICE_ROLE_KEY || globalThis.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcGNndHh5ZmJ0dHNhYXNjb213Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NDkyMTI0NCwiZXhwIjoyMTAwNDk3MjQ0fQ.6KgaRQ4uFdKyxeYgTRhd0T-gM7FWvByR8u5VwSgR9rM';
const ADMIN_SECRET = globalThis.process?.env?.ADMIN_SECRET || globalThis.ADMIN_SECRET || 'kmm-admin-secret-2026-gdpcgtx';

function hash(s){ let h=5381; for(let i=0;i<s.length;i++){ h=((h<<5)+h)+s.charCodeAt(i); h|=0;} return 'h_'+h.toString(36); }
function uid(){ return 'c_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function signToken(pwHash){
  const exp = Date.now() + 1000*60*60*24*7;
  return btoa(JSON.stringify({p:pwHash, e:exp, s:hash(pwHash+exp+ADMIN_SECRET)}));
}
function verifyToken(tok){
  try{
    const d=JSON.parse(atob(tok));
    if(d.e < Date.now()) return null;
    if(d.s !== hash(d.p+d.e+ADMIN_SECRET)) return null;
    return d.p;
  }catch(e){return null;}
}
function badRequest(msg,code=400){return res({error:msg},code);}
function res(obj,status=200){
  return new Response(JSON.stringify(obj),{status,headers:{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store, must-revalidate',
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,POST,OPTIONS',
    'access-control-allow-headers':'content-type'
  }});
}
function getIp(req){return ((req.headers.get('x-forwarded-for')||'').split(',')[0].trim())||req.headers.get('x-real-ip')||'';}
function getGeo(req){return{
  country:req.headers.get('x-vercel-ip-country')||'',
  region:decodeURIComponent(req.headers.get('x-vercel-ip-country-region')||''),
  city:decodeURIComponent(req.headers.get('x-vercel-ip-city')||''),
  ua:req.headers.get('user-agent')||''
};}

// In-memory store fallback (survives in same edge isolate)
if(!globalThis.__KMM_STORE) globalThis.__KMM_STORE = {pwHash:hash('kyle2026'), threads:{}};
const MEM = globalThis.__KMM_STORE;

/* ──────── Supabase helpers ──────── */
async function sb(path,opts={}){
  const r=await fetch(SB_URL+'/rest/v1'+path,{
    method:opts.method||'GET',
    headers:{'apikey':SB_KEY,'Authorization':'Bearer '+SB_KEY,'content-type':'application/json','prefer':opts.returning?'return='+opts.returning:'return=representation'},
    body:opts.body?JSON.stringify(opts.body):undefined
  });
  if(r.status===204) return {};
  const t=await r.text(); try{return JSON.parse(t);}catch(e){return{raw:t};}
}
async function sbAll(){
  if(!SB_URL||!SB_KEY) return Object.values(MEM.threads).sort((a,b)=>(b.lastAt||b.createdAt)-(a.lastAt||a.createdAt));
  try{const rows=await sb('/kmm_threads?select=data&order=updated_at.desc'); if(Array.isArray(rows)) return rows.map(r=>r.data); return[];}catch(e){return[];}
}
async function sbGet(id){
  if(!SB_URL||!SB_KEY) return MEM.threads[id]||null;
  try{const rows=await sb('/kmm_threads?id=eq.'+encodeURIComponent(id)+'&select=data'); if(Array.isArray(rows)&&rows[0]) return rows[0].data; return null;}catch(e){return null;}
}
async function sbUp(t){
  if(!SB_URL||!SB_KEY){MEM.threads[t.id]=t; return t;}
  const exists = await sbGet(t.id);
  try{
    if(exists) await sb('/kmm_threads?id=eq.'+encodeURIComponent(t.id),{method:'PATCH',body:{data:t}});
    else await sb('/kmm_threads',{method:'POST',body:{id:t.id,data:t}});
  }catch(e){}
  return t;
}
async function sbDel(id){
  if(!SB_URL||!SB_KEY){delete MEM.threads[id]; return;}
  try{await sb('/kmm_threads?id=eq.'+encodeURIComponent(id),{method:'DELETE'});}catch(e){}
}

/* ──────── Auth helper ──────── */
function isAdmin(params){
  const pw = params?.pw || '';
  const tok = params?.token || '';
  if(tok){const ph=verifyToken(tok); if(ph && ph===MEM.pwHash) return true;}
  if(hash(pw||'')===MEM.pwHash) return true;
  return false;
}
function signFor(params){
  if(hash(params?.pw||'')===MEM.pwHash) return signToken(MEM.pwHash);
  if(params?.token && verifyToken(params.token)) return signToken(MEM.pwHash); // refresh
  return null;
}

/* ──────── Actions ──────── */
async function createThread(body, req){
  const id=uid(), now=Date.now();
  const t={id,name:String(body?.name||'').slice(0,80),email:String(body?.email||'').slice(0,120),
    ip:getIp(req), ...getGeo(req), ipHistory:[],
    createdAt:now, lastAt:now, unread:1,
    messages:[{from:'admin', text:body?.name?('Thanks '+String(body.name).split(' ')[0]+'! What can I help you with today?'):"Hi! I'd love to help — send me your question below and I'll get back to you shortly.", ts:now}]};
  await sbUp(t);
  return {thread:t};
}
async function updateContact(id,name,email){
  const t=await sbGet(id); if(!t) return badRequest('Thread not found',404);
  t.name=String(name||t.name||'').slice(0,80); t.email=String(email||t.email||'').slice(0,120); t.lastAt=Date.now();
  await sbUp(t); return {thread:t};
}
async function sendMsg(id,text){
  const t=await sbGet(id); if(!t) return badRequest('Thread not found',404);
  t.messages.push({from:'visitor',text:String(text||'').slice(0,2000),ts:Date.now()});
  t.unread=(t.unread||0)+1; t.lastAt=Date.now();
  await sbUp(t); return {thread:t};
}
async function reply(id,text,params){
  if(!isAdmin(params)) return badRequest('Unauthorized',401);
  const t=await sbGet(id); if(!t) return badRequest('Thread not found',404);
  t.messages.push({from:'admin',text:String(text||'').slice(0,2000),ts:Date.now()});
  t.unread=0; t.lastAt=Date.now();
  await sbUp(t); return {thread:t};
}
async function markRead(id,params){
  const t=await sbGet(id); if(!t) return badRequest('Thread not found',404);
  t.unread=0; await sbUp(t); return {ok:true};
}
async function delThread(id,params){
  if(!isAdmin(params)) return badRequest('Unauthorized',401);
  await sbDel(id); return {ok:true};
}
async function allThreads(params){
  if(!isAdmin(params)) return badRequest('Unauthorized',401);
  return {threads:await sbAll(), pwHash:MEM.pwHash, token:signFor(params), serverTime:Date.now(), supabase:!!(SB_URL&&SB_KEY)};
}
async function login(pw){
  if(hash(pw||'')!==MEM.pwHash) return {ok:false};
  return {ok:true, token:signToken(MEM.pwHash), pwHash:MEM.pwHash};
}
async function chPw(cur,nw,params){
  if(!isAdmin(params) && hash(cur||'')!==MEM.pwHash) return badRequest('Auth required',401);
  if(hash(cur||'')!==MEM.pwHash) return badRequest('Current password is incorrect.');
  if(!nw||nw.length<4) return badRequest('New password must be at least 4 characters.');
  MEM.pwHash=hash(nw);
  return {ok:true, token:signToken(MEM.pwHash)};
}

export default async function handler(req){
  if(req.method==='OPTIONS') return res('',204);
  const url=new URL(req.url);
  try{
    if(req.method==='GET'){
      const tid=url.searchParams.get('tid');
      const admin=url.searchParams.get('admin');
      const params={pw:url.searchParams.get('pw')||'', token:url.searchParams.get('token')||''};
      if(admin==='1'){return res(await allThreads(params));}
      if(tid){const t=await sbGet(tid); return res({thread:t, serverTime:Date.now(), supabase:!!(SB_URL&&SB_KEY)});}
      return badRequest('Missing tid or admin param');
    }
    if(req.method==='POST'){
      const body=await req.json().catch(()=>({}));
      switch(body.action){
        case 'login': return res(await login(body.pw));
        case 'createThread': return res(await createThread(body, req));
        case '_updateContact': return res(await updateContact(body.tid, body.name, body.email));
        case 'sendMsg': return res(await sendMsg(body.tid, body.text));
        case 'reply': return res(await reply(body.tid, body.text, body));
        case 'markRead': return res(await markRead(body.tid, body));
        case 'deleteThread': return res(await delThread(body.tid, body));
        case 'changePassword': return res(await chPw(body.current, body.next, body));
        default: return badRequest('Unknown action');
      }
    }
    return badRequest('Method not allowed',405);
  }catch(e){console.error('api error',e); return res({error:'Server error', msg:String(e&&e.message||e)},500);}
}
