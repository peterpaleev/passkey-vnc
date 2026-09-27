# Passkey VNC

An always-on Linux desktop you can open from iPhone or Android as a Home Screen web app. The browser shows a virtual X11 session through noVNC. A passkey protects sign-in; the phone confirms with Face ID, fingerprint, or its approved device unlock. A saved session reconnects automatically. The desktop and web gateway restart after crashes and boot without a graphical login.

This repository contains only reusable code and configuration. No personal accounts, passwords, passkeys, or runtime data are included. The app code is MIT licensed; third-party packages retain their own licenses.

## What you need

- A Linux machine using systemd user services (Ubuntu 24.04+ recommended), with network access and an account that can run `sudo` during installation.
- Node.js **22 or newer** at `/usr/bin/node`, plus npm and `git`.
- `Xvfb`, `x11vnc`, `xauth`, `mcookie`, `xdpyinfo`, `openbox`, and `xterm`. On Ubuntu, install with:

  ```sh
  sudo apt update
  sudo apt install git nodejs npm xvfb x11vnc xauth x11-utils openbox xterm
  node --version
  ```

  Some Ubuntu releases package Node.js below 22. In that case, install a supported system Node.js package first, then check `/usr/bin/node --version`.
- A domain name pointing to the machine's public IP, with TCP 80 and 443 reachable. If the computer is behind a home router, forward those ports to it. If it is behind CGNAT, use a VPS/reverse tunnel or another HTTPS endpoint instead. Passkeys require a trusted HTTPS origin on the phone.

The virtual desktop is separate from the machine's physical screen. Its X11 display defaults to `:99` at 1600×900. If you need to share an existing physical desktop instead, the always-on virtual mode is not the right setup; ask for the physical-session variant.

## Install on the Linux machine

Clone this repository exactly to `~/passkey-vnc`:

```sh
git clone https://github.com/peterpaleev/passkey-vnc.git ~/passkey-vnc
cd ~/passkey-vnc
bash scripts/install-ubuntu.sh https://remote.example.com
```

Replace `remote.example.com` with your own domain. The installer checks dependencies, runs `npm ci`, writes a private configuration under `~/.config/remote-desk/`, enables user services, and enables linger so they start after reboot before login. It leaves existing configuration untouched if you rerun it. Installed source stays in your clone; state and invitations live in `~/.local/share/remote-desk/` with private permissions. Both VNC and the web gateway listen only on localhost.

Point your HTTPS reverse proxy at `127.0.0.1:8765`. With [Caddy](https://caddyserver.com/docs/quick-starts/https), a Caddyfile site block is:

```caddyfile
remote.example.com {
    reverse_proxy 127.0.0.1:8765
}
```

Caddy handles TLS certificates and WebSocket upgrades for this simple reverse proxy. Install Caddy using its [official instructions](https://caddyserver.com/docs/install), add the site block to your Caddyfile, validate its configuration and reload it. Use the same exact `https://remote.example.com` value in `REMOTE_ORIGIN`. If you already serve other sites, add this as another site block rather than replacing your existing Caddyfile. For a different proxy, forward HTTP and WebSocket requests while preserving the public `Origin` header.

Check service status:

```sh
systemctl --user status remote-desk-desktop remote-desk-web
ss -ltn | grep -E ':5901|:8765'
curl -I https://remote.example.com/remote/
```

The `ss` output should show only `127.0.0.1` for ports 5901 and 8765. HTTPS should serve the app page. See logs with `journalctl --user -u remote-desk-desktop -u remote-desk-web -f`.

## Set up your phone

On the Linux machine, generate one private setup invitation:

```sh
cd ~/passkey-vnc
npm run invite
```

Open the resulting link on your phone, tap **Create my passkey**, and confirm with your device. The link expires after 24 hours and works once. If you cancel, the same open page can retry for five minutes; after reloading, generate another invitation. Keep the invitation private. The app removes it from browser history as soon as it opens.

On iPhone, use Safari → Share → **Add to Home Screen**. On Android, use Chrome's menu → **Install app** or **Add to Home Screen**. The icon opens `/remote/`. While your 30-day session is valid it reconnects without prompting. After locking or expiry, tap **Sign in with passkey** and confirm with Face ID, fingerprint, or your device unlock. A website cannot invoke biometrics silently; the tap is required on many phones.

The mobile toolbar has a keyboard button, fit/zoom, panning, Escape and Lock. Openbox is started with an xterm window; you can start programs from that terminal. Install the applications you want to use in the remote desktop separately.

## Operations and recovery

```sh
systemctl --user restart remote-desk-desktop remote-desk-web
systemctl --user stop remote-desk-desktop remote-desk-web
systemctl --user start remote-desk-desktop remote-desk-web
```

When the network drops or the app is backgrounded, it retries on return. The virtual desktop stays running unless its service or computer stops. Reboot persistence uses `loginctl enable-linger` and `systemctl --user enable`.

To add a new passkey, sign in and generate a new invitation locally. The current signed-in passkey can be revoked using `POST /remote/api/passkey/remove` with a freshly verified session; that also revokes its sessions. If your phone is lost, generate a fresh invitation on the Linux machine and remove the old credential from private state with care. Back up `~/.local/share/remote-desk/state.json` privately if you want to preserve registered passkeys across reinstallations; keep it out of Git.

`REMOTE_ORIGIN` is bound into WebAuthn passkeys. Changing the hostname requires enrolling a new passkey for the new domain. The app requires an exact browser origin, user verification, a signed one-time challenge, and a live server-side session before opening the VNC socket. Session cookies are HttpOnly, Secure, SameSite=Strict and last at most 30 days. VNC has no separate password because it is bound to loopback and the public path checks the passkey session.

Run `npm run check` and `tests/remote-auth.mjs` for validation; the [CI workflow](.github/workflows/test.yml) runs a virtual desktop and a disposable software passkey end to end. Physical Face ID and Home Screen installation must be verified on the phone itself.
