// Signed software-authenticator integration tests. No browser or business input.
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,createHash,sign} from 'node:crypto';
import {isoCBOR} from '@simplewebauthn/server/helpers';
import {WebSocket} from 'ws';
const BASE=process.env.TEST_BASE || 'http://127.0.0.1:8780';
const ORIGIN=process.env.TEST_ORIGIN || 'http://localhost:8780';
const invite=process.env.TEST_INVITE;
assert(invite,'TEST_INVITE required');
const rpID=new URL(ORIGIN).hostname;
const digest=b=>createHash('sha256').update(b).digest();
const b64=b=>Buffer.from(b).toString('base64url');
let jar={};
function cookie(){return Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ');}
async function post(name,body,origin=ORIGIN){
  const r=await fetch(`${BASE}/remote/api/${name}`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie()},body:JSON.stringify(body)});
  for(const c of r.headers.getSetCookie()){const [k,v]=c.split(';')[0].split('=');jar[k]=v;}
  return {status:r.status,body:await r.json(),headers:r.headers};
}
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
const jwk=publicKey.export({format:'jwk'}),id=randomBytes(32);
const cose=isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x,'base64url')],[-3,Buffer.from(jwk.y,'base64url')]]));
const counter=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
function clientData(type,challenge,origin=ORIGIN){return Buffer.from(JSON.stringify({type,challenge,origin,crossOrigin:false}));}
function registration(challenge){
  const len=Buffer.alloc(2);len.writeUInt16BE(id.length);
  const authData=Buffer.concat([digest(rpID),Buffer.from([0x45]),counter(0),Buffer.alloc(16),len,id,cose]);
  return {id:b64(id),rawId:b64(id),type:'public-key',response:{clientDataJSON:b64(clientData('webauthn.create',challenge)),attestationObject:b64(isoCBOR.encode(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))),transports:['internal']},clientExtensionResults:{}};
}
function assertion(challenge,n,{origin=ORIGIN,uv=true,badSignature=false}={}){
  const client=clientData('webauthn.get',challenge,origin);
  const auth=Buffer.concat([digest(rpID),Buffer.from([uv?5:1]),counter(n)]);
  const signature=sign('sha256',Buffer.concat([auth,digest(client)]),privateKey);
  if(badSignature)signature[signature.length-1]^=1;
  return {id:b64(id),rawId:b64(id),type:'public-key',response:{clientDataJSON:b64(client),authenticatorData:b64(auth),signature:b64(signature)},clientExtensionResults:{}};
}
async function rejectedSocket(headers){
  await new Promise((resolve,reject)=>{
    const ws=new WebSocket(BASE.replace(/^http/,'ws')+'/remote/socket',{headers});
    ws.on('unexpected-response',(_req,res)=>{assert.equal(res.statusCode,401);ws.terminate();resolve();});
    ws.on('open',()=>{ws.close();reject(Error('Unauthorized socket accepted'));});ws.on('error',()=>{});
    setTimeout(()=>{ws.terminate();reject(Error('Socket timeout'));},5000).unref();
  });
}
await rejectedSocket({Origin:ORIGIN});
assert.equal((await post('register/options',{})).status,403);
assert.equal((await post('login/options',{},'https://invalid.example')).status,403);
const options=await post('register/options',{invite});assert.equal(options.status,200);
const reg=registration(options.body.challenge);
assert.equal((await post('register/verify',reg)).status,200);
assert.equal((await post('register/verify',reg)).status,400,'registration replay');
assert.equal((await post('register/options',{invite})).status,200,'fresh owner session may add passkey');
await post('logout',{});
assert.equal((await post('register/options',{invite})).status,403,'invitation must be single use');
for(const bad of [{origin:'https://invalid.example'},{uv:false},{badSignature:true}]){
  const o=await post('login/options',{});
  assert.equal((await post('login/verify',assertion(o.body.challenge,1,bad))).status,400);
}
const login=await post('login/options',{}),response=assertion(login.body.challenge,1);
const verified=await post('login/verify',response);assert.equal(verified.status,200);
assert.match(verified.headers.get('set-cookie'),/HttpOnly/);assert.match(verified.headers.get('set-cookie'),/Secure/);
assert.equal((await post('login/verify',response)).status,400,'authentication replay');
await rejectedSocket({Origin:'https://invalid.example',Cookie:cookie()});
// Complete RFB initialization and request a real framebuffer (no input events).
await new Promise((resolve,reject)=>{
  const ws=new WebSocket(BASE.replace(/^http/,'ws')+'/remote/socket',{headers:{Origin:ORIGIN,Cookie:cookie()}});
  let data=Buffer.alloc(0),stage=0;
  const timer=setTimeout(()=>{ws.terminate();reject(Error('Framebuffer timeout'));},15000);
  ws.on('error',reject);
  ws.on('message',chunk=>{
    data=Buffer.concat([data,chunk]);
    while(true){
      if(stage===0){if(data.length<12)return;assert.match(data.subarray(0,12).toString(),/^RFB/);data=data.subarray(12);ws.send(Buffer.from('RFB 003.008\n'));stage++;}
      else if(stage===1){if(data.length<2)return;assert.equal(data[0],1);assert.equal(data[1],1);data=data.subarray(2);ws.send(Buffer.from([1]));stage++;}
      else if(stage===2){if(data.length<4)return;assert.equal(data.readUInt32BE(),0);data=data.subarray(4);ws.send(Buffer.from([1]));stage++;}
      else if(stage===3){if(data.length<24)return;const size=24+data.readUInt32BE(20);if(data.length<size)return;
        const width=data.readUInt16BE(0),height=data.readUInt16BE(2);assert(width>0&&height>0);console.log(`RFB desktop ${width} × ${height}`);
        data=data.subarray(size);const req=Buffer.alloc(10);req[0]=3;req.writeUInt16BE(Math.min(width,64),6);req.writeUInt16BE(Math.min(height,64),8);ws.send(req);stage++;}
      else{if(data.length<20)return;assert.equal(data[0],0);assert(data.readUInt16BE(2)>0);clearTimeout(timer);ws.close();console.log('Framebuffer received through authenticated WebSocket');resolve();return;}
    }
  });
});
const oldCookie=cookie();
assert.equal((await post('passkey/remove',{})).status,200);
await rejectedSocket({Origin:ORIGIN,Cookie:oldCookie});
const removed=await post('login/options',{});assert.equal((await post('login/verify',assertion(removed.body.challenge,2))).status,400);
console.log('PASS: registration, login, signature/UV/origin enforcement, replay prevention, session cookies, private RFB, revocation');
