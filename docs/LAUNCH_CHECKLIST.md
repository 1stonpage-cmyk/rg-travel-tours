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

Four things Phase 1 and Week 3 found the hard way. Each one is a config line that
silently disables a security control or a scheduled job if it's missing — no error, no
log line, nothing to notice until it's exploited or until something leaks. Set all four
before the app ever takes real traffic, and re-check them any time the PM2 or nginx
config changes.

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
- [ ] **`SITE_ENV=production` is set** in the deployed `.env`. Separate from `NODE_ENV`, and
      checked separately: it is what `robots.txt` and the `X-Robots-Tag` middleware read. It
      defaults to `development`, and anything other than `production` fails closed to
      `Disallow: /`. The failure is silent and in the _safe_ direction — the site simply never
      gets crawled — so nothing will alert you; see section (c).
- [ ] **PM2 runs the API in fork mode, a single instance** — not cluster mode. **Two
      independent reasons, either one sufficient on its own.**
      **Reason 1, the rate limiter:** `express-rate-limit`'s default `MemoryStore` is
      per-process. Cluster mode with N workers gives each worker its own counter, so the
      effective rate limit becomes N times the configured value, split unpredictably
      across workers by whichever one handles a given request. If cluster mode is ever
      needed for throughput, the limiter needs a shared store (e.g. Redis) first — don't
      switch PM2 modes without also doing that.
      **Reason 2, the schedules:** `node-cron` schedules live in the app process (owner
      decision 2026-10-12, Week 3 Q1). Under cluster mode every worker runs every
      schedule, so the minutely hold-expiry sweep fires N times a minute. That sweep is
      idempotent by requirement, so it corrupts nothing — but it multiplies the database
      load by the worker count, and any future job that is _not_ idempotent would do real
      damage. A shared store does **not** fix this one: the schedule has to be owned by
      exactly one process.

---

## Verify EARLY — before the code that depends on it is written

Not launch-day items. Each is a hosting-level fact no amount of correct application code
works around, so finding it late means a rewrite rather than a fix.

- [ ] **Send a test email over SMTP from the VPS itself**, before Week 4 writes the
      notification layer against it. Many hosts block outbound 25/465/587 on cheaper
      plans, silently or as a generic timeout, and **IONOS has blocked outbound SMTP on
      another of this owner's projects** — a known failure mode, not a hypothetical. Test
      **from the VPS**, not from a laptop; the laptop's network says nothing about the
      server's. Email was deferred to Week 4 by owner decision 2026-10-12 (Week 3 Q2),
      which is exactly why this test is worth doing now, while it is still free.

      **PROPOSED transport, NOT YET CONFIRMED — do not act on the vendor choice yet:**
      `nodemailer` over SMTP, with **Brevo's SMTP relay (free tier)** as the proposed default
      provider, and **no other email library**.
      Status: this reached the project through a subagent's thread rather than the owner's own
      message to the session that owns this file, so the vendor is recorded here as a proposal
      awaiting the owner's confirmation. **Confirm the provider before creating any account or
      putting credentials anywhere.** The `nodemailer`-over-SMTP shape is the spec's own stack
      (§2) and is not in question; only the provider is.
      Whatever provider is confirmed, every value lives in `.env` — `SMTP_HOST`, `SMTP_PORT`,
      `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — so swapping providers is a config change, not
      a code change. Tests use a **mock transport and never send real email.**

      **If the VPS turns out to be blocked, that decision needs revisiting rather than
      working around:** `nodemailer` over SMTP cannot work at all through a blocked port, so
      the fallback is Brevo's **HTTP API over plain `fetch`** (the same pattern as the
      PayMongo provider — still no new dependency, but no longer `nodemailer`). Which is
      why this test comes before the email layer is built, not after.

- [ ] **AFTER the owner confirms the provider** (see the status note above — do not create an
      account for an unconfirmed vendor), create the account, generate its SMTP credentials, and
      put them in the deployed `.env` only — never in the repo (`SMTP_PASS` is a secret like any
      gateway key).

- [ ] **Add the sender-authentication DNS records in Cloudflare for `travelsugbo.com`:**
      **SPF**, **DKIM** (both from the chosen provider's own setup page, since the DKIM key is
      account-specific) and a **DMARC** record. **This item does not wait on the provider
      decision** — every sending domain needs all three whoever sends the mail, and DNS
      propagation has real lead time, so it is the part worth starting first. Without SPF and DKIM, booking confirmations
      from a brand-new sending domain land in spam or are rejected outright — and a guest who
      never receives their booking reference cannot find their booking, which turns a working
      system into a support call. Verify them with the provider's own domain check **and**
      independently (`dig TXT travelsugbo.com`, `dig TXT <selector>._domainkey.travelsugbo.com`,
      `dig TXT _dmarc.travelsugbo.com`) before trusting the dashboard's green tick. Start DMARC
      at `p=none` so nothing is silently discarded while the records are being proven, then
      tighten it.

### The owner account and the origin allowlist — BLOCKING

Both are `.env` values with no safe default, and the app is wrong in a different way for
each if they are missing: no owner can sign in, or every browser request is refused.

- [ ] **Set `OWNER_EMAIL` and `OWNER_PASSWORD` in the deployed `.env`**, then run
      `pnpm --filter @rg/server db:seed`. Use a **strong, unique** password of at least 12
      characters — the seed refuses anything shorter, and refuses one variable without the
      other. There is no default and nothing committed: a password in the repository is the
      real credential on the live site the day someone forgets to change it.
- [ ] **Remove `OWNER_PASSWORD` from the server `.env` once the first seed has run.** The
      hash is in the database from that moment and the plaintext has no further use, so
      leaving it is a credential sitting in a file for no benefit. (Re-adding it and
      re-seeding is also the password-reset path, which is why the seed updates an existing
      owner rather than failing on the duplicate email — there is no reset screen until the
      admin weeks.)
- [ ] **Set `APP_ORIGIN=https://travelsugbo.com`** in the deployed `.env`. It is the only
      origin allowed to make a state-changing request (CSRF, §12), and outside production the
      Vite dev server on 5180 is allowed as well — which is exactly why production must be set
      explicitly rather than left on the default. Verify after deploy: a `POST` to `/trpc/...`
      with a foreign `Origin` must answer **403**.
      **`/api/webhooks/*` is deliberately exempt** — a gateway sends no `Origin` and is
      protected by signature verification instead, so a check there would reject every real
      payment notification. Confirm a signed test webhook still succeeds when you do the
      gateway wire check below.

### The gateway wire check — BLOCKING, and no test in the suite can substitute for it

Owner decision 2026-10-13: **no PayMongo or Xendit account exists yet**, so the live test-mode
check is **deferred, not skipped**. Week 3's payment layer is built and tested against a **mock**
provider, which proves our side of the seam and nothing at all about PayMongo's.

What the suite already proves: `startPayment`'s refusals, the amount read off the booking row,
the one-time hold extension, the four fixed methods, `recordPayment`, the signature check, and
webhook idempotency on `(provider, provider_event_id)`. What it **cannot** prove, because no real
response has ever been seen: that PayMongo's actual checkout response parses into what the
provider expects, that its actual signature header verifies against our verifier, and that its
actual event names match what the webhook router switches on. All three were assumed from
documentation, and a mismatch in any one of them means **a guest pays and the booking never
confirms** — money taken, no trip booked, and no error anyone sees until they complain.

- [ ] **Create the PayMongo account** (R&G's own — it carries the merchant relationship, the
      settlement bank account and the KYC), and Xendit later only if a second gateway is actually
      wanted. The `PaymentProvider` seam already exists, so adding one is configuration, not a
      rewrite.
- [ ] **Put the TEST keys in `.env`** — `PAYMONGO_SECRET_KEY`, `PAYMONGO_PUBLIC_KEY`,
      `PAYMONGO_WEBHOOK_SECRET`. **Never in chat, never in a commit, never in a screenshot.**
      Test keys are lower-stakes than live ones, but the habit is what protects the live ones.
- [ ] **Expose the dev server with a tunnel** (`cloudflared tunnel --url http://localhost:3100`)
      and **register that URL as a TEST webhook** in the PayMongo dashboard. The webhook has to
      reach the app from outside, and `localhost` cannot.
- [ ] **Drive ONE real test-mode booking end to end** — quote, hold, pay with a test card or
      test GCash, and confirm the **webhook** moves the booking to `confirmed`. Never the
      redirect: a booking that only turns `confirmed` after the redirect is a defect, not a pass
      (CLAUDE.md), and this is the one run that would catch it for real.
- [ ] **Confirm the three assumed shapes one at a time** — the checkout response parses, the
      signature header verifies, the event names match the router's switch — and treat any
      difference as a bug to fix **and cover with a test**, not a surprise to work around.
- [ ] **Delete the dev tunnel's webhook registration afterwards.** Left behind it is a dashboard
      full of permanent delivery failures, and worse: a tunnel URL someone else may later be
      issued becomes an endpoint that accepts unsigned traffic aimed at this app.

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

   Then **seed the settings rows, before the first start**:

   ```bash
   pnpm --filter @rg/server db:seed    # settings, incl. the booking window
   ```

   `readSettings()` **fails closed**: it throws on the first missing key, so a settings row
   the code expects and the database does not have takes the whole public site down with a
   500 rather than degrading. The newest such key is `booking` (the bookable date window —
   `minLeadDays`, `nextDayCutoffTime`, `maxAdvanceDays`), added 2026-10-13, so a database
   seeded before that date is missing it. The seed is idempotent and upserts by natural key,
   so running it again is safe and is the fastest way to be sure.

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
   - [ ] No `X-Robots-Tag` header on the apex; `robots.txt` allows crawling (it answers
         `Disallow: /` unless **both** `SITE_ENV=production` and
         `settings.content_unverified = false`).
   - [ ] `curl -s https://travelsugbo.com/sitemap.xml` lists the live public URLs, and no URL
         in it is served `noindex` (`curl -s -H 'Accept: text/html' <url> | grep robots`).
   - [ ] Per-route meta is really being injected, not just the shell's defaults — send the
         header, or you get the static shell and a false pass:
         `curl -s -H 'Accept: text/html' https://travelsugbo.com/privacy | grep -E '<title>|canonical'`.
   - [ ] A test booking reaches PayMongo and the webhook marks it paid (never the
         redirect URL — CLAUDE.md).
   - [ ] Customer, driver and admin logins each reach only their own area.
   - [ ] Email (and SMS, if enabled) actually sends.

8. **Keep the holding page** at `/var/www/travelsugbo/coming-soon` on disk. If anything
   goes wrong, pointing `root` back at it is a one-line, 30-second rollback.

9. **After launch**: decide whether `preview.travelsugbo.com` stays as a staging host
   (keep basic auth + `noindex`) or is retired.

10. **After launch — retire the holding page's contact duplication.** The contact details
    currently live in **two** places that a guard keeps in step. Once the coming-soon page is
    gone for good, remove the contact constants from `client/src/lib/site.ts`, delete
    `scripts/check-contact-parity.mjs` and drop `check:contact` from the root `test` script, so
    `settings.contact` becomes the single, admin-editable source of truth.

---

## (c) Before you flip the switch — reminders

### Placeholder content must be gone

`client/src/lib/placeholder-data.ts` no longer exists — task 3.7 deleted it, and the whole
public site now reads tours, destinations, packages, reviews, FAQs and settings from the
`rg_travel` database. So "placeholder content" is a **database state**, not a file, and the
build guard (`client/scripts/check-placeholders.mjs`) asks the database rather than the
filesystem. It blocks every production build while either condition below holds.

Do these in order, against the production `rg_travel` database:

- [ ] **Delete or unpublish every `is_sample` review.** The guard blocks the build while any
      review has `status = 'published' AND is_sample = 1`, because CLAUDE.md forbids
      presenting seeded social proof as real. Either way is fine — hide them or delete them —
      but the seeded six must not be published.
      Check: `SELECT COUNT(*) FROM reviews WHERE status='published' AND is_sample=1;` → `0`.
- [ ] **Client supplies real tours, prices, photos, descriptions and permit numbers**, then
      set `settings.content_unverified = false`. The guard blocks the build while it is true.
      This is also what **publishes the site to search engines**: while the flag is set,
      `robots.txt` answers `Disallow: /` and every route is served `noindex,nofollow`. Do not
      clear it until the content is genuinely real.
- [ ] **`SITE_ENV=production` is set in the deployed `.env`.** It defaults to `development`,
      and `robots.txt` fails closed to `Disallow: /` for any value other than `production` —
      so a correct, fully verified site stays uncrawlable if this line is missing. (This is
      deliberate: it is what keeps a preview deploy out of the index.)
      Check after deploy: `curl -s https://travelsugbo.com/robots.txt` names the sitemap and
      does **not** say `Disallow: /`.
- [ ] **`ALLOW_PLACEHOLDER_BUILD` must NOT be set for the launch build.** It exists only
      for deliberate client demos. If `pnpm build` succeeds while the flag is unset, the
      content guard is satisfied — that is the signal you want. If you had to set it, you are
      not ready to launch.
- [ ] The amber placeholder banner (`PlaceholderBadge.tsx`, driven by the same
      `content_unverified` flag) does not appear anywhere on the live site.

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

### Payments — operational, before the first real charge

These four came out of the core-schema build (Tasks 14–16b, October 2026). Each one is a way the
payment path can fail **quietly** — money that looks fine in the gateway dashboard and never lands
correctly here — so none of them is visible without an explicit check.

- [ ] **Server time is NTP-synchronised, and verified.** PayMongo signatures are only accepted
      inside a **±300-second window**, and the timestamp is inside the signed payload so it cannot
      be adjusted in flight. A deploy clock more than five minutes out therefore rejects **every
      genuine webhook**, and the failure looks like "PayMongo never called us". Check with
      `timedatectl status` (expect `System clock synchronized: yes`) and keep `systemd-timesyncd`
      or `chrony` running. Re-check after any VPS migration or restore from snapshot.
- [ ] **A daily check or alert on `payment_events` where `processed_at IS NULL`.** A row with a
      null `processed_at` is an event that arrived, was stored, and was never applied — a guest who
      paid and is not confirmed. The webhook deliberately fails closed in several places (an
      unmappable payment method, a refund event with no admin flow yet), and every one of those
      leaves exactly this trace. Nothing surfaces it on its own.
      `SELECT provider, provider_event_id, type, received_at FROM payment_events WHERE processed_at IS NULL ORDER BY received_at;`
- [ ] **Confirm PayMongo's real field names on the first test-mode transaction.** The provider's
      field mapping was written from PayMongo's published documentation, not from a live payload.
      Before trusting it, run one test-mode payment and check the webhook body actually uses
      `payment_method_used` (versus `source.type`) and the instrument strings the mapping expects
      (`gcash`, `paymaya`, `grab_pay`, `qrph`, `dob`, `brankas_*`). An unrecognised string maps to
      `null` rather than a guess, so a mismatch is safe but will block the payment.
- [ ] **An admin review queue for `bookings.payment_review_required = 1` exists.** When money
      arrives for a booking whose hold had already expired or that was cancelled, the payment is
      recorded and the booking is **deliberately not confirmed** — confirming it could oversell the
      day. The booking is flagged instead and an audit row records why. **Nothing clears that flag
      today and nothing displays it**, so without a queue those guests are invisible: they have
      paid, and no one is looking at them. The queue must let an admin re-confirm (if capacity
      allows) or refund, and must write an audit row either way.
      `SELECT id, ref, status, amount_paid_centavos FROM bookings WHERE payment_review_required = 1;`
