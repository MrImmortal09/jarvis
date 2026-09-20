# Hosting JARVIS on a server

The face is static files; the brain is one Node process. nginx serves the first
and proxies to the second, so the browser sees a single HTTPS origin — which is
also what makes the microphone available.

```
browser ──https──> nginx ──┬─ /            static face      (dist/)
                           ├─ / + Upgrade  WebSocket ─────> bridge on 127.0.0.1:8787
                           └─ /tts /stt …  bridge HTTP ───> bridge on 127.0.0.1:8787
```

## One-time setup (Ubuntu)

1. **Node 20+**, and a service user with nothing in its home:
   `sudo useradd --system --create-home --home-dir /var/lib/jarvis --shell /usr/sbin/nologin jarvis`
2. **Code** — `git clone <repo> /opt/jarvis`, then
   `npm ci --omit=dev --ignore-scripts` inside it.
3. **Secrets and settings** — copy `deploy/bridge.env.example` to
   `/etc/jarvis/bridge.env`, fill it in, `chmod 600`, owner root.
4. **Service** — copy `deploy/jarvis-bridge.service` to
   `/etc/systemd/system/`, then `systemctl enable --now jarvis-bridge`.
5. **Certificate** — with a bare `server { listen 80; server_name <domain>; }`
   in place, run `certbot --nginx -d <domain>`.
6. **Site** — replace that with `deploy/nginx-jarvis.conf` (edit the domain),
   and create the login it asks for:
   `printf 'jarvis:%s\n' "$(openssl passwd -apr1)" | sudo tee /etc/nginx/jarvis.htpasswd`
   then `nginx -t && systemctl reload nginx`.

## Every update

```
DEPLOY_HOST=ubuntu@<ip> DEPLOY_DOMAIN=<domain> deploy/deploy.sh
```

Builds the face locally, copies it over, pulls the brain on the server and
restarts it.

## Things worth knowing

- **The login is not optional.** The bridge has no authentication of its own and
  drives an agent that can read files and spend the API budget behind it. nginx
  basic auth is the only thing between it and the internet.
- **Writes stay off.** `JARVIS_ALLOW_WRITES` is unset, so JARVIS can look but not
  change anything. Turning it on for a public host is a decision, not a default.
- **Gateway tokens are often locked to an IP.** If turns fail with a 403 that
  mentions IPs, the token is being used from somewhere it was not issued for —
  which is what you want from the outside, and a surprise from your laptop.
- **Behind Cloudflare**, set SSL/TLS mode to *Full* (or *Full (strict)*), never
  *Flexible*: the origin redirects HTTP to HTTPS and Flexible loops forever.
