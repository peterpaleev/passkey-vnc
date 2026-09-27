// Never cache desktop frames, cookies, API responses or invitations.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.mode==='navigate')event.respondWith(fetch(event.request).catch(()=>new Response(
    '<!doctype html><meta name="viewport" content="width=device-width"><title>Remote Desk</title><body style="font:18px system-ui;padding:30px;background:#10231d;color:white"><h1>Computer unavailable</h1><p>Check your connection and that your computer is on.</p><button onclick="location.reload()">Try again</button>',
    {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})));
});
