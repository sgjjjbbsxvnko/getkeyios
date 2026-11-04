import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import worker from './ios-worker.js';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
const db = {prepare(sql) {return {bind(...args){return {async run(){return {meta:{changes:1}}}}}}}};
const env={DB:db,LINK4M_API_TOKEN:'mock-valid-token',IOS_API_LIMITER:{async limit(){return {success:true}}}};
async function checkResponse(mock, expected, status=502){globalThis.fetch=mock;const r=await worker.fetch(new Request('https://ios.local/api/ios/link4m/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),env);const j=await r.json();assert.equal(r.status,status);assert.equal(j.error,expected,j.error)}
await checkResponse(async()=>new Response('<html>error</html>',{status:200}), 'LINK4M_INVALID_RESPONSE');
await checkResponse(async()=>new Response(JSON.stringify({status:'error',message:'bad-token'}),{status:200}), 'LINK4M_API_REJECTED');
await checkResponse(async()=>new Response('forbidden',{status:403}), 'LINK4M_AUTH_FAILED');
await checkResponse(async()=>new Response('ratelimited',{status:429}), 'LINK4M_RATE_LIMITED',429);
await checkResponse(async()=>new Response('',{status:502}), 'LINK4M_UPSTREAM_UNAVAILABLE');
await checkResponse(async()=>{throw new TypeError('fetch failed')}, 'LINK4M_NETWORK_ERROR');
await checkResponse(async()=>new Response('',{status:302,headers:{location:'https://untrusted.example/api-shorten/v2'}}), 'LINK4M_UNTRUSTED_API_REDIRECT');
let calls=0;
globalThis.fetch=async(url)=>{calls++;const u=new URL(url);assert.ok(['link4m.co','www.link4m.co'].includes(u.hostname));if(calls===1)return new Response('',{status:301,headers:{location:'https://www.link4m.co/api-shorten/v2'}});assert.equal(u.searchParams.get('api'),'mock-valid-token');return new Response(JSON.stringify({status:'success',shortenedUrl:'https://link4m.co/example'}),{status:200});};
const res=await worker.fetch(new Request('https://ios.local/api/ios/link4m/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),env);const data=await res.json();assert.equal(res.status,200);assert.equal(data.shortUrl,'https://link4m.co/example');assert.equal(calls,2);
console.log('PASS: Link4M provider invalid JSON, rejected token, 403, 429, 5xx, network, unsafe redirect, safe redirect');
