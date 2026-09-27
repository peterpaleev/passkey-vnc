import express from 'express';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, createHash} from 'node:crypto';
import {WebSocketServer, WebSocket} from 'ws';
import {generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse} from '@simplewebauthn/server';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=process.env.REMOTE_DATA || path.resolve(ROOT,'data');
const ORIGIN=process.env.REMOTE_ORIGIN;
if(!ORIGIN || !/^https:\/\/[^/]+$/.test(ORIGIN) && !/^http:\/\/localhost(?::\d+)?$/.test(ORIGIN))
  throw Error('Set REMOTE_ORIGIN to the exact public HTTPS origin (localhost HTTP is allowed for tests).');
const rpID=new URL(ORIGIN).hostname;
const PORT=Number(process.env.REMOTE_PORT || 8765);
const VNC_PORT=Number(process.env.REMOTE_VNC_PORT || 5901);
const TITLE=process.env.REMOTE_TITLE || 'Remote Desk';
const USER_NAME=process.env.REMOTE_USER || 'owner';
const TTL=30*24*60*60;
const hash=value=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
process.umask(0o077);
fs.mkdirSync(DATA,{recursive:true,mode:0o700});
function write(name,value){
  fs.writeFileSync(path.join(DATA,name+'.tmp'),JSON.stringify(value),{mode:0o600});
  fs.renameSync(path.join(DATA,name+'.tmp'),path.join(DATA,name));
}
if(process.argv.includes('--invite')){
  const value=token();
  write('invite.json',{hash:hash(value),expires:Date.now()+24*60*60*1000});
  console.log(`${ORIGIN}/remote/#invite=${value}`);
  process.exit(0);
}
const stateFile=path.join(DATA,'state.json');
const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):
  {userID:token(),credentials:[],sessions:{}};
function save(){
  for(const [id,s] of Object.entries(state.sessions)) if(s.expires<Date.now()) delete state.sessions[id];
  write('state.json',state);
}
save();
const flows=new Map();
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));}
function session(req){const s=state.sessions[hash(cookies(req).remote_session||'')];return s?.expires>Date.now()?s:null;}
function cookie(res,name,value,seconds){res.append('Set-Cookie',`${name}=${value}; Path=/remote/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`);}
function flow(res,type,challenge){
  const id=token();flows.set(hash(id),{type,challenge,expires:Date.now()+300000});
  cookie(res,'remote_flow',id,300);
}
function takeFlow(req,type){
  const id=hash(cookies(req).remote_flow||'');const f=flows.get(id);flows.delete(id);
  if(!f || f.type!==type || f.expires<Date.now()) throw Error('Expired request. Please try again.');
  return f;
}
function loggedIn(req,res,credentialID){
  const old=cookies(req).remote_session;if(old) delete state.sessions[hash(old)];
  const id=token();state.sessions[hash(id)]={expires:Date.now()+TTL*1000,verified:Date.now(),credentialID};save();
  cookie(res,'remote_session',id,TTL);cookie(res,'remote_flow','',0);
}
setInterval(()=>{for(const [id,f] of flows) if(f.expires<Date.now()) flows.delete(id);},60000).unref();
const app=express();
app.disable('x-powered-by');
// This standalone gateway serves only the remote app and passkey endpoints.
app.use((req,res,next)=>{
  if(!req.url.startsWith('/remote/')) return res.redirect(302,'/remote/');
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
    'Content-Security-Policy':`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ${ORIGIN.replace(/^http/,'ws')}; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`});
  next();
});
app.use('/remote/api',rateLimit({windowMs:60000,limit:90,standardHeaders:true,legacyHeaders:false}));
app.use('/remote/api',(req,res,next)=>{
  if(req.method==='POST' && (req.headers.origin!==ORIGIN || !req.is('application/json')))
    return res.status(403).json({error:'Invalid request origin'});
  next();
},express.json({limit:'32kb'}));
app.get('/remote/api/session',(req,res)=>res.json({authenticated:!!session(req)}));
app.post('/remote/api/register/options',async(req,res)=>{
  let authorized=session(req)?.verified>Date.now()-300000;
  if(!authorized && typeof req.body.invite==='string'){
    const f=path.join(DATA,'invite.json');
    const invitation=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;
    if(invitation?.expires>Date.now() && invitation.hash===hash(req.body.invite)){
      // Redeem once before async operations. A failed enrollment needs a new invitation.
      fs.unlinkSync(f);authorized=true;
    }
  }
  if(!authorized) return res.status(403).json({error:'Open a valid setup invitation to add your first passkey.'});
  const options=await generateRegistrationOptions({rpName:TITLE,rpID,
    userName:USER_NAME,userDisplayName:TITLE,userID:Buffer.from(state.userID,'base64url'),
    attestationType:'none',excludeCredentials:state.credentials.map(c=>({id:c.id,transports:c.transports})),
    authenticatorSelection:{residentKey:'required',userVerification:'required',authenticatorAttachment:'platform'}});
  flow(res,'register',options.challenge);res.json(options);
});
app.post('/remote/api/register/verify',async(req,res)=>{
  const f=takeFlow(req,'register');
  const v=await verifyRegistrationResponse({response:req.body,expectedChallenge:f.challenge,
    expectedOrigin:ORIGIN,expectedRPID:rpID,requireUserVerification:true});
  if(!v.verified || !v.registrationInfo) throw Error('Passkey verification failed');
  const c=v.registrationInfo.credential;
  if(state.credentials.some(x=>x.id===c.id)) throw Error('Passkey already exists');
  state.credentials.push({...c,publicKey:Buffer.from(c.publicKey).toString('base64url')});
  loggedIn(req,res,c.id);res.json({ok:true});
});
app.post('/remote/api/login/options',async(_req,res)=>{
  const options=await generateAuthenticationOptions({rpID,userVerification:'required',allowCredentials:[]});
  flow(res,'login',options.challenge);res.json(options);
});
app.post('/remote/api/login/verify',async(req,res)=>{
  const f=takeFlow(req,'login');const stored=state.credentials.find(c=>c.id===req.body.id);
  if(!stored) throw Error('Passkey not recognized');
  const v=await verifyAuthenticationResponse({response:req.body,expectedChallenge:f.challenge,
    expectedOrigin:ORIGIN,expectedRPID:rpID,requireUserVerification:true,
    credential:{...stored,publicKey:new Uint8Array(Buffer.from(stored.publicKey,'base64url'))}});
  if(!v.verified) throw Error('Passkey verification failed');
  stored.counter=v.authenticationInfo.newCounter;loggedIn(req,res,stored.id);res.json({ok:true});
});
app.post('/remote/api/passkey/remove',(req,res)=>{
  const s=session(req);
  if(!s || s.verified<Date.now()-300000) return res.status(403).json({error:'Sign in again before removing your passkey.'});
  // A fresh session may remove only the passkey that authenticated that session.
  state.credentials=state.credentials.filter(c=>c.id!==s.credentialID);
  for(const [id,value] of Object.entries(state.sessions))if(value.credentialID===s.credentialID)delete state.sessions[id];
  save();cookie(res,'remote_session','',0);res.json({ok:true});
});
app.post('/remote/api/logout',(req,res)=>{
  delete state.sessions[hash(cookies(req).remote_session||'')];save();
  cookie(res,'remote_session','',0);res.json({ok:true});
});
app.use('/remote/vendor/novnc',express.static(path.join(ROOT,'node_modules/@novnc/novnc'),{dotfiles:'deny',index:false}));
app.get('/remote/passkeys.js',(_req,res)=>res.sendFile(path.join(ROOT,'node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js')));
app.use('/remote',express.static(path.join(ROOT,'public'),{dotfiles:'deny'}));
app.use('/remote',(_req,res)=>res.status(404).json({error:'Not found'}));
app.use((err,_req,res,_next)=>res.status(400).json({error:err.message?.includes('Expired request')?err.message:'Request could not be verified. Please try again.'}));
const server=http.createServer(app);
const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
server.on('upgrade',(req,socket,head)=>{
  if(!req.url.startsWith('/remote/')){socket.destroy();return;}
  if(req.url!=='/remote/socket' || req.headers.origin!==ORIGIN || !session(req)){
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');return;
  }
  wss.handleUpgrade(req,socket,head,ws=>{
    const tcp=net.connect(VNC_PORT,'127.0.0.1');
    const guard=setInterval(()=>{if(!session(req)) ws.close(1008,'Session expired');else ws.ping();},15000);
    tcp.on('data',data=>{
      if(ws.readyState!==WebSocket.OPEN)return;
      tcp.pause();ws.send(data,{binary:true},()=>tcp.resume());
    });
    ws.on('message',(data,isBinary)=>{
      if(!isBinary){ws.close(1003);return;}
      if(!tcp.write(data)) ws.pause();
    });
    tcp.on('drain',()=>ws.resume());
    const cleanup=()=>{clearInterval(guard);tcp.destroy();if(ws.readyState===WebSocket.OPEN)ws.close();};
    tcp.on('error',cleanup);tcp.on('close',cleanup);ws.on('error',cleanup);ws.on('close',cleanup);
  });
});
server.listen(PORT,'127.0.0.1',()=>console.log(`Remote gateway listening on loopback ${PORT}`));
