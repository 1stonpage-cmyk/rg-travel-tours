# Launch Checklist — TravelSugbo.com

How the holding page and the real app sit side by side before launch, and the exact
steps to swap them on launch day.

**Nothing in this file is a deploy instruction to run now.** Deployment is a separate,
dedicated prompt (CLAUDE.md). This is the plan to follow when that prompt comes.

Reference values used below:

| Thing             | Value                                                           |
| ----------------- | --------------------------------------------------------------- |
| Holding page root | `/var/www/travelsugbo/coming-soon` (this repo's `/coming-soon`) |
| Built app root    | `/var/www/travelsugbo/app` (this repo's `client/dist`)          |
| Node API (PM2)    | `127.0.0.1:3100`                                                |
| Public brand      | TravelSugbo                                                     |
| Licensed operator | R&G Travel & Tours                                              |

---

## (a) nginx plan — before launch

Two server blocks. The apex serves static HTML only; the preview host serves the real
app and must never be indexed.

### 1. `travelsugbo.com` → the Coming Soon page (public, indexable)

```nginx
server {
    listen 443 ssl http2;
    server_name travelsugbo.com www.travelsugbo.com;

    # certbot --nginx -d travelsugbo.com -d www.travelsugbo.com
    ssl_certificate     /etc/letsencrypt/live/travelsugbo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/travelsugbo.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    root /var/www/travelsugbo/coming-soon;
    index index.html;

    # Static holding page only — no proxy_pass, no /trpc, no /api.
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Hero photo and favicon: long cache, they are content-hashed by name.
    location ~* \.(webp|jpg|svg)$ {
        expires 30d;
        add_header Cache-Control "public";
    }

    # The page itself must stay short-cached so the launch-day swap is visible fast.
    location = /index.html {
        add_header Cache-Control "no-cache";
    }
}

server {
    listen 80;
    server_name travelsugbo.com www.travelsugbo.com;
    return 301 https://travelsugbo.com$request_uri;
}
```

Deliberately **no** `X-Robots-Tag` and **no** `noindex` here — the holding page is meant
to be found and indexed (spec task 1D).

### 2. `preview.travelsugbo.com` → the real app (private, never indexed)

```nginx
server {
    listen 443 ssl http2;
    server_name preview.travelsugbo.com;

    ssl_certificate     /etc/letsencrypt/live/preview.travelsugbo.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/preview.travelsugbo.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # Keep the whole preview host out of every index, on every response
    # (including 401s, hence `always`).
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;

    # HTTP basic auth across the entire host, API included.
    auth_basic           "TravelSugbo preview";
    auth_basic_user_file /etc/nginx/.htpasswd-travelsugbo;

    root /var/www/travelsugbo/app;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;   # SPA fallback for React Router
    }

    location /trpc/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Create the password file once:

```bash
sudo htpasswd -c /etc/nginx/.htpasswd-travelsugbo travelsugbo   # prompts for a password
sudo chmod 640 /etc/nginx/.htpasswd-travelsugbo
sudo chown root:www-data /etc/nginx/.htpasswd-travelsugbo
```

Also add a `robots.txt` on the preview host that disallows everything — belt and braces
next to the `X-Robots-Tag` header. Basic auth already blocks crawlers; the header covers
the window where auth is temporarily lifted for a client walkthrough.

Checks before leaving it running:

- [ ] `curl -I https://preview.travelsugbo.com/` returns **401**.
- [ ] `curl -sI https://preview.travelsugbo.com/ | grep -i x-robots-tag` shows `noindex`.
- [ ] `curl -I https://travelsugbo.com/` returns **200** and has **no** `X-Robots-Tag`.
- [ ] `nginx -t` passes before every `systemctl reload nginx`.
- [ ] The preview host never serves `/uploads` — receipts stay behind the authenticated
      app route (CLAUDE.md security rules).

---

## Deployment requirements — not optional

Three things Phase 1 found the hard way. Each one is a config line that silently
disables a security control if it's missing — no error, no log line, nothing to
notice until it's exploited or until something leaks. Set all three before the app
ever takes real traffic, and re-check them any time the PM2 or nginx config changes.

- [ ] **Express `trust proxy` is set**, because the app sits behind nginx (see the
      `proxy_pass` blocks above). The rate limiter keys on request IP. Without
      `trust proxy`, Express reads nginx's own address for every request, so every
      visitor collectively shares one IP's worth of rate limit — one abusive visitor
      exhausts the login/coupon/review limiter for everyone else behind the same
      proxy, not just themselves.
- [ ] **`NODE_ENV=production` is set** in the PM2 environment. tRPC's default error
      formatter includes the `stack` field when `NODE_ENV` is not `production`, so a
      malformed or hostile request gets a stack trace — file paths, call sites — back
      in the response instead of a plain error message.
- [ ] **PM2 runs the API in fork mode, a single instance** — not cluster mode.
      `express-rate-limit`'s default `MemoryStore` is per-process. Cluster mode with N
      workers gives each worker its own counter, so the effective rate limit becomes N
      times the configured value, split unpredictably across workers by whichever one
      handles a given request. If cluster mode is ever needed for throughput, the
      limiter needs a shared store (e.g. Redis) first — don't switch PM2 modes without
      also doing that.

---

## (b) Launch day — point travelsugbo.com at the real app

Do these in order. Steps 1–4 change nothing public, so they are safe to do early.

1. **Build the app from a clean tree** on the deploy box:

   ```bash
   git pull
   pnpm install --frozen-lockfile
   pnpm typecheck && pnpm lint && pnpm test
   pnpm build          # ALLOW_PLACEHOLDER_BUILD must NOT be set — see (c)
   ```

2. **Apply any pending database migration** to the production `rg_travel` database, and
   confirm the app boots against it.

3. **Publish the build**: sync `client/dist` into `/var/www/travelsugbo/app`, confirm
   `pm2 restart` brings the API up on 3100, and smoke-test the whole flow on
   `preview.travelsugbo.com` while it is still behind basic auth.

4. **Snapshot the rollback**: keep the previous `app` directory and the current nginx
   config (`cp /etc/nginx/sites-available/travelsugbo{,.bak-$(date +%F)}`).

5. **Switch the apex**: in the `travelsugbo.com` server block, change `root` to
   `/var/www/travelsugbo/app`, add the SPA `try_files` fallback and the `/trpc/` and
   `/api/` proxy blocks from the preview config — **without** the `auth_basic` and
   `X-Robots-Tag` lines. The apex must be public and indexable.

6. **Reload**: `sudo nginx -t && sudo systemctl reload nginx`.

7. **Verify live**, in this order:
   - [ ] `https://travelsugbo.com/` loads the real home page, hero photo included.
   - [ ] No `X-Robots-Tag` header on the apex; `robots.txt` allows crawling.
   - [ ] A test booking reaches PayMongo and the webhook marks it paid (never the
         redirect URL — CLAUDE.md).
   - [ ] Customer, driver and admin logins each reach only their own area.
   - [ ] Email (and SMS, if enabled) actually sends.

8. **Keep the holding page** at `/var/www/travelsugbo/coming-soon` on disk. If anything
   goes wrong, pointing `root` back at it is a one-line, 30-second rollback.

9. **After launch**: decide whether `preview.travelsugbo.com` stays as a staging host
   (keep basic auth + `noindex`) or is retired.

---

## (c) Before you flip the switch — reminders

### Placeholder content must be gone

- [ ] `client/src/lib/placeholder-data.ts` is deleted (spec task 8D), or every value in
      it has been replaced by real settings/DB data. No invented ratings, guest counts,
      review counts or prices.
- [ ] **`ALLOW_PLACEHOLDER_BUILD` must NOT be set for the launch build.** It exists only
      for deliberate client demos. If `pnpm build` succeeds while the flag is unset, the
      placeholder guard (`client/scripts/check-placeholders.mjs`) is satisfied — that is
      the signal you want. If you had to set it, you are not ready to launch.
- [ ] The dev-only amber placeholder banner does not appear in the production build.

### Real values confirmed by the client

Confirmed and live on both surfaces:

- [x] Primary line `0908 469 6246` (Smart) — WhatsApp, Viber and calls.
- [x] Alternate line `0927 737 8431` (Globe) — calls and SMS.
- [x] Facebook page URL.

Still outstanding:

- [ ] Email (currently `hello@travelsugbo.com`, still env-overridable).
- [ ] Office address and opening hours.
- [ ] Contact values live in **two** places that must match — `client/src/lib/site.ts`
      and `coming-soon/index.html`. `pnpm check:contact` enforces it; run it after any
      contact change rather than eyeballing both files.

### Permits and legal

- [ ] Real DOT, DTI and BIR numbers supplied and entered in Settings — **never invent an
      accreditation number**; until then they render as pending.
- [ ] The copyright notice, accreditation block and "Operated by" credit all name
      **R&G Travel & Tours**, not the TravelSugbo brand.
- [ ] Privacy notice page live and the checkout consent checkbox present (RA 10173).

### Hero photo

- [ ] **Confirm usage rights for the hero photograph.** The source file is
      `assets-source/lapping-cebu-2008612.jpg` (Fort San Pedro, Cebu City), supplied by
      the client. `assets-source/` is gitignored — the 4.6 MB original lives on the
      build machine only, so keep a backup off this repo. Confirm in writing that the client owns it or holds a licence that
      covers commercial web use, and record the photographer credit if one is required.
- [ ] Derived files in `client/public/hero/` and `coming-soon/img/` are regenerated if
      the source photo is ever replaced (1920 + 800 wide, WebP + JPG, each under 300 KB).

### Security sweep

- [ ] HTTPS only, HSTS on, cookies `secure`, `httpOnly`, `sameSite=lax`.
- [ ] PayMongo secret key and webhook secret only in server `.env`, never in client code.
- [ ] `/uploads` is outside the web root and reachable only through the authenticated route.
- [ ] Rate limits active on logins, coupon checks, reviews, inquiries and helpful votes.
- [ ] Basic auth credentials for the preview host rotated or the host retired.
