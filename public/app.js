import RFB from './vendor/novnc/core/rfb.js';
const $=id=>document.getElementById(id);
let rfb=null,timer=null,attempt=0,locked=false,connecting=false;
let invite=new URLSearchParams(location.hash.slice(1)).get('invite'),enrollmentOptions=null;
if(invite)history.replaceState(null,'',location.pathname);
async function api(endpoint,body){
  const response=await fetch(`./api/${endpoint}`,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Connection failed');return data;
}
function message(text){$('message').textContent=text;}
function showLogin(){locked=true;clearTimeout(timer);rfb?.disconnect();rfb=null;$('desktop').hidden=true;$('welcome').hidden=false;$('status').textContent='Locked';$('login').disabled=false;}
function retry(){
  if(locked || document.hidden)return;
  clearTimeout(timer);timer=setTimeout(connect,Math.min(15000,1000*2**Math.min(attempt++,4)));
}
async function connect(){
  if(connecting || locked)return;
  connecting=true;clearTimeout(timer);
  try{
    if(!(await api('session')).authenticated){showLogin();return;}
    const previous=rfb;rfb=null;previous?.disconnect();
    $('welcome').hidden=true;$('desktop').hidden=false;$('connection').hidden=false;
    $('connection-text').textContent='Connecting to your computer…';$('status').textContent='Connecting…';
    const client=new RFB($('screen'),`${location.protocol==='https:'?'wss':'ws'}://${location.host}/remote/socket`);
    rfb=client;client.scaleViewport=true;client.resizeSession=false;client.qualityLevel=5;client.compressionLevel=6;
    client.addEventListener('connect',()=>{if(rfb!==client)return;attempt=0;$('connection').hidden=true;$('status').textContent='Connected · remote desktop';});
    client.addEventListener('disconnect',()=>{
      if(rfb!==client || locked)return;
      rfb=null;$('connection').hidden=false;$('connection-text').textContent='Connection lost. Reconnecting…';$('status').textContent='Reconnecting…';retry();
    });
    client.addEventListener('securityfailure',()=>{$('connection-text').textContent='Connection could not be authorized. Lock and sign in again.';});
  }catch(_error){$('status').textContent='Computer unavailable';$('connection-text').textContent='Your computer is temporarily unavailable. Retrying…';message('Waiting for your computer to come online…');retry();}
  finally{connecting=false;}
}
$('login').onclick=async()=>{
  $('login').disabled=true;message('Confirm with your device biometrics or passcode.');
  try{
    const options=await api('login/options',{});
    const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:options});
    await api('login/verify',response);locked=false;message('');await connect();
  }catch(e){message(e.name==='NotAllowedError'?'Sign-in cancelled. Tap to try again.':e.message);}
  finally{$('login').disabled=false;}
};
$('enroll').onclick=async()=>{
  $('enroll').disabled=true;message('Save your passkey on this device.');
  try{
    if(!enrollmentOptions){enrollmentOptions=await api('register/options',{invite});invite=null;}
    const response=await SimpleWebAuthnBrowser.startRegistration({optionsJSON:enrollmentOptions});
    await api('register/verify',response);$('enroll').hidden=true;$('login').hidden=false;locked=false;message('');await connect();
  }catch(e){message(e.name==='NotAllowedError'?'Setup cancelled. Tap Create my passkey to try again within five minutes.':e.message);}
  finally{$('enroll').disabled=false;}
};
$('logout').onclick=async()=>{try{await api('logout',{});showLogin();}catch(_e){$('status').textContent='Could not lock. Please retry.';}};
$('retry').onclick=()=>{locked=false;connect();};
$('fit').onclick=()=>{if(!rfb)return;rfb.scaleViewport=!rfb.scaleViewport;rfb.clipViewport=!rfb.scaleViewport;$('fit').textContent=rfb.scaleViewport?'Zoom':'Fit';};
$('pan').onclick=()=>{if(!rfb)return;rfb.dragViewport=!rfb.dragViewport;$('pan').setAttribute('aria-pressed',String(rfb.dragViewport));};
$('escape').onclick=()=>rfb?.sendKey(0xff1b,'Escape');
$('keyboard').onclick=()=>{$('typing').focus();};
$('typing').addEventListener('input',event=>{
  if(event.isComposing)return;
  for(const char of event.target.value){const code=char.codePointAt(0);rfb?.sendKey(code>255?0x01000000|code:code);}
  event.target.value='';
});
$('typing').addEventListener('keydown',event=>{
  const keys={Backspace:0xff08,Enter:0xff0d,Tab:0xff09};
  if(keys[event.key]){event.preventDefault();rfb?.sendKey(keys[event.key],event.code);}
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden && !locked)connect();});
window.addEventListener('online',()=>{if(!locked)connect();});
window.addEventListener('pageshow',event=>{if(event.persisted && !locked)connect();});
if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
if(invite){$('login').hidden=true;$('enroll').hidden=false;$('status').textContent='Private setup';$('description').textContent='Create a passkey on this device to securely access your computer.';}
else if(!window.PublicKeyCredential){$('status').textContent='Passkeys unavailable';message('Please open this link in a modern browser with passkey support.');}
else{locked=false;connect();}
