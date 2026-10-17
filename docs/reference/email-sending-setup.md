# PathQuote — Email Sending Setup (Resend + q.pathfindercut.com)

Status: application code implemented; production DNS and environment setup required. Date: 2026-09-01.

## Current state (verified via DNS)

```
pathfindercut.com  MX    10 pathfindercut-com.mail.protection.outlook.com   ← Microsoft 365
pathfindercut.com  TXT   v=spf1 ip4:101.178.245.208 ip4:16.26.190.226
                         a:dedr6.oecompanion.com include:spf.gici.com.au
                         include:spf.protection.outlook.com -all
_dmarc             TXT   v=DMARC1; p=quarantine; aspf=s;
NS                       jamie.ns.cloudflare.com / vin.ns.cloudflare.com    ← DNS is on Cloudflare
```

Notes:
- DNS is hosted at **Cloudflare**, not Microsoft. Records get added there.
- DMARC is `p=quarantine` with **`aspf=s` (strict SPF alignment)** and **no `rua=`** (no reporting).
- Leftover `brevo-code:` TXT verification suggests a previous Brevo setup — can be cleaned up.

## Why not plain SMTP through Microsoft 365

- Microsoft **permanently disabled Basic authentication for SMTP AUTH client submission**
  (`smtp.office365.com` + username/password). That path is gone.
- What remains inside M365: SMTP AUTH with **OAuth 2.0 (XOAUTH2)** or the **Graph API
  `sendMail`** — both need an Entra app registration, admin consent, and token plumbing in code.
- Even then M365 throttles at ~30 messages/min, 10,000 recipients/day, and every bounce or spam
  complaint from the app lands on the **company tenant's** sending reputation.

Conclusion: use a transactional provider on a dedicated subdomain. **Resend** chosen.

## Architecture

| Piece | Value |
|---|---|
| Provider | Resend |
| Sending domain (verified in Resend) | `q.pathfindercut.com` |
| From | `PathQuote <noreply@q.pathfindercut.com>` |
| Reply-To | quote author's mailbox, falling back to `EMAIL_REPLY_TO` |
| Return-Path (bounces) | `send.q.pathfindercut.com` (Resend default) |
| Company mail (M365) | untouched — root MX, root SPF, autodiscover all stay as-is |

### Important: From address

Resend only lets you send from the domain you verify. If you verify
`q.pathfindercut.com`, the From address **must** be `…@q.pathfindercut.com`.
`noreply@pathfindercut.com` would require verifying the **root** domain in Resend instead,
which mixes app reputation into the company's main domain. Not recommended.

`noreply@` receives nothing — set **Reply-To** to a monitored mailbox so clients replying to a
quote reach a human.

### DMARC alignment

With `aspf=s`, SPF alignment fails (From `q.pathfindercut.com` vs Return-Path
`send.q.pathfindercut.com`). DMARC still **passes via DKIM**, which is relaxed by default
(`adkim` unset) and aligns on the shared org domain. This works, but it is fragile — one
misconfigured DKIM record and everything gets quarantined.

Recommended DMARC change:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@pathfindercut.com;
```

i.e. **drop `aspf=s`** (relaxed alignment is the standard default) and **add `rua=`** so
failures are visible instead of silent.

## DNS records to add (Cloudflare, zone `pathfindercut.com`)

Exact values come from the Resend dashboard after adding the domain. Shape:

| Type | Name | Value | Priority | Proxy |
|---|---|---|---|---|
| MX | `send.q` | `feedback-smtp.<region>.amazonses.com` | 10 | — |
| TXT | `send.q` | `v=spf1 include:amazonses.com ~all` | — | — |
| TXT | `resend._domainkey.q` | `p=<DKIM public key from Resend>` | — | DNS only |
| TXT | `_dmarc` | *(modify existing — see above)* | — | — |

Cloudflare's "Name" field is relative to the zone, so enter `send.q`, not
`send.q.pathfindercut.com`.

**Must not change:** root `MX`, root `SPF` TXT, `autodiscover`, any `selector1/2._domainkey`
M365 records. Adding subdomain records cannot affect company mail flow.

## Application config

`src/auth.ts` uses the Auth.js Nodemailer provider reading `SMTP_*`, with the PathQuote
magic-link template and Reply-To handling already implemented. Production still needs these
environment values:

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxxxxxxxxxx      # Resend API key
EMAIL_FROM="PathQuote <noreply@q.pathfindercut.com>"
EMAIL_REPLY_TO=quotes@pathfindercut.com
```

Port 587 (STARTTLS) is used deliberately: `src/auth.ts` does not pass `secure: true`, so
port 465 (implicit TLS) would be wrong.

`EMAIL_REPLY_TO` is the **fallback**, not the usual answer — see below.

## Step-by-step (self-serve — you have Cloudflare access)

### 1. Resend account + domain

1. Sign up at resend.com. Use a **company-owned** address, not personal — this becomes
   production infrastructure.
2. **Domains → Add Domain** → enter `q.pathfindercut.com`.
3. Pick a **region**. It only affects sending latency, not deliverability. Recipients are
   mostly AU, so `ap-northeast-1` (Tokyo) or `us-east-1` are both fine.
4. Choose **Manual setup** (the Cloudflare "Sign in" / Domain Connect button also works and
   writes the records for you — but on a zone that carries live company mail, add them by hand
   so nothing else gets touched).
5. Resend now shows 3 records. Leave the tab open.

### 2. Cloudflare — add the 3 records

Cloudflare → `pathfindercut.com` → **DNS → Records → Add record**.

The Name field is relative to the zone: strip `.pathfindercut.com` off whatever Resend shows.

| # | Type | Name | Content | Priority |
|---|---|---|---|---|
| 1 | MX | `send.q` | `feedback-smtp.<region>.amazonses.com` | 10 |
| 2 | TXT | `send.q` | `v=spf1 include:amazonses.com ~all` | — |
| 3 | TXT | `resend._domainkey.q` | `p=<long DKIM key>` | — |

Notes:
- Paste TXT values **raw, without surrounding quotes** — Cloudflare adds them.
- The DKIM key is longer than 255 chars; Cloudflare splits it into strings automatically.
- MX and TXT records can't be proxied, so there's no orange cloud to worry about.
- Priority `10` on `send.q` does not collide with the root MX — different name, different
  record set.

**Do not touch:** root `MX`, root SPF TXT (the `v=spf1 … include:spf.protection.outlook.com -all`
one), `autodiscover`, `selector1/selector2._domainkey`. Everything above lives on the `q` /
`send.q` subdomain and cannot affect company mail.

### 3. Cloudflare — edit the DMARC record

Find the existing `_dmarc` TXT:

```
v=DMARC1; p=quarantine; aspf=s;
```

Change to:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@pathfindercut.com;
```

Dropping `aspf=s` because strict SPF alignment can't be satisfied by any provider that uses a
bounce subdomain — right now it silently leaves DKIM as the only thing holding up DMARC for
*all* company mail, M365 included. Adding `rua=` so failures become visible.

`dmarc@pathfindercut.com` must be able to receive mail. If it doesn't exist, either ask GI to
create it (see below) or point `rua=` at an address that does.

### 4. Verify

Back in Resend → **Verify DNS Records**. Usually a few minutes.

Check from your side too:

```bash
dig +short TXT resend._domainkey.q.pathfindercut.com
dig +short TXT send.q.pathfindercut.com
dig +short MX  send.q.pathfindercut.com
dig +short TXT _dmarc.pathfindercut.com
```

### 5. API key

Resend → **API Keys → Create**. Permission: **Sending access** only. Scope it to the
`q.pathfindercut.com` domain. Copy the key once — it isn't shown again.

### 6. App config

On the server, in `.env`:

```
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_xxxxxxxxxxxxxxxxxxxx
EMAIL_FROM="PathQuote <noreply@q.pathfindercut.com>"
EMAIL_REPLY_TO=quotes@pathfindercut.com
```

Deploy the current application code and recreate the app container so it receives the new
environment values.

### 7. Test

1. Trigger a magic-link login to a Gmail address.
2. Gmail → **Show original**. Want three lines: `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
   DMARC passing via DKIM (with SPF showing as unaligned) is expected and fine.
3. Optional: send to a mail-tester.com address for a spam score.

### 8. Watch it for a week

Resend dashboard shows bounces and complaints. DMARC `rua` reports start arriving within a day
or two — worth skimming the first few to confirm nothing else on the domain broke.

---

## The one thing you still need GI for

Everything above you can do yourself. The only piece needing M365 admin is a mailbox:

> Hi team — we're standing up an internal app that sends transactional email from a dedicated
> subdomain (`q.pathfindercut.com`), separate from the M365 tenant. No changes to company mail
> flow. Two small asks:
>
> 1. The app sends from a no-reply address, so we need a monitored mailbox for the Reply-To
>    header — can you confirm `quotes@pathfindercut.com` exists, or create it? A shared mailbox
>    is fine.
> 2. We're adding a `rua=` address to the domain's DMARC record so authentication failures are
>    actually reported. Could you create `dmarc@pathfindercut.com` (shared mailbox) to receive
>    those? Happy to forward anything interesting your way.
>
> Also, minor housekeeping: there's a stale `brevo-code:...` TXT verification string on the root
> domain from a previous provider — safe to remove if nothing still uses Brevo.

## Later (post-v1)

When quote emails to clients get added, introduce a `REPLY_TO` env var and set it on outgoing
mail. Consider a second Resend subdomain if marketing/bulk mail ever appears, so transactional
reputation stays isolated.

---

## Who receives replies

`EMAIL_FROM` is `noreply@q.pathfindercut.com` — a Resend sending subdomain that accepts no
mail. Clients reply to it anyway; nobody reads the word "noreply". So every message carries a
Reply-To, resolved by `resolveReplyTo()` in `src/lib/email/reply-to.ts`:

| Situation | Reply-To |
|---|---|
| Quote email, author is an active user | that manager (`Document.author`) |
| Quote email, author deactivated or missing | `EMAIL_REPLY_TO` (`sales@pathfindercut.com`) |
| Signing invite, to the client (`sendQuoteForSignature`) | same rule as above — the quote's author if active, else `EMAIL_REPLY_TO` |
| Revoked-link notice, to the client (`revokeSigningLink`) | same rule as above |
| Completion copy, to the client, PDF attached (`sendCompletionEmails`) | same rule as above |
| Completion notice, to the quote's own author (`sendCompletionEmails`) | none — always `undefined`. A message telling someone they themselves just got a quote signed needs no Reply-To, so this one is hardcoded rather than resolved |
| Sign-in / magic-link email (no author) | `EMAIL_REPLY_TO` |
| `EMAIL_REPLY_TO` blank and no author | no Reply-To header at all |

A client replying to their quote reaches the person who built it. A deactivated author falls
back deliberately: their mailbox is likely gone, so routing there loses the reply silently —
worse than the shared inbox.

Display names are RFC 5322-quoted when they contain specials (`Smith, John` →
`"Smith, John" <…>`), and CR/LF is stripped so an editable profile name can't inject headers.

**Wired up.** Quote emailing to clients shipped with electronic quote signing
(`docs/superpowers/plans/2026-09-07-quote-signing.md`). The real callers are
`sendQuoteForSignature` and `revokeSigningLink` in `src/lib/actions/signing.ts`
(the invite and the withdrawal notice) and the `sendCompletionEmails` helper
inside `src/lib/actions/signing-client.ts` (the two emails sent once a client
finishes signing — one to the client with the archived PDF attached, one to
the author with a link back into the app). Three of the four resolve
Reply-To exactly as sketched here, passing the document's author straight
through:

```ts
replyTo: resolveReplyTo(document.author, process.env.EMAIL_REPLY_TO)
```

The fourth — the completion notice to the author themselves — passes no
Reply-To at all rather than calling `resolveReplyTo`, since a message telling
someone they just received their own client's signature needs no reply
address. See the table below for all four side by side.

## Implementation notes

`src/auth.ts` overrides the Auth.js Nodemailer provider's `sendVerificationRequest`. The default
template is branded "Auth.js" and sets no Reply-To, and its `html`/`text` helpers live at an
unexported deep path inside `@auth/core`.

The template itself is a pure function in `src/lib/email/magic-link.ts` — no Prisma, no
NextAuth, no env reads — so it is unit-testable without booting the auth stack. Covered by
`tests/magic-link-email.test.ts` (URL escaping in the href, Reply-To passthrough, blank-Reply-To
handling, no raw token in visible link text) and `tests/reply-to.test.ts` (author preference,
deactivated-author fallback, RFC 5322 quoting, header injection).

Link lifetime lives in one constant, `MAGIC_LINK_MAX_AGE_SECONDS` in `src/auth.ts`, feeding both
the provider's `maxAge` and the "valid for N minutes" copy, so the two can't drift.

## Troubleshooting: "it says sent but nothing arrives"

This was a real trap. `sendMagicLink` swallowed every `AuthError` and returned generic
success — and Auth.js wraps a throwing `sendVerificationRequest` in `EmailSignInError`, which
*is* an `AuthError`. So an SMTP failure looked identical to a successful send, with nothing
logged. Fixed: send failures are now logged (`[auth] magic link send failed`) and surfaced to
the user.

Fastest way to see the real error:

```bash
docker compose run --rm tools npx tsx scripts/send-test-email.ts you@example.com
```

It prints the resolved config, runs `transport.verify()` (separating "can't connect or
authenticate" from "server rejected this message"), sends, and dumps the SMTP response.

| Symptom | Cause |
|---|---|
| `535` / auth failed | wrong or revoked API key in `SMTP_PASS` |
| `403` domain not verified | `q.pathfindercut.com` not verified in Resend yet |
| `450`/`550` on the From address | `EMAIL_FROM` isn't at a domain verified in Resend |
| `ETIMEDOUT` / `ECONNREFUSED` | outbound 587 blocked by the host firewall |
| script succeeds, login page doesn't | container running old env — recreate, see below |
| nothing sent, no error, "check your email" | address isn't in the `User` table |

That last row is the one to check first, and it is invisible by design: `callbacks.signIn` in
`src/auth.ts` rejects unknown or inactive addresses *before* @auth/core issues a token or calls
`sendVerificationRequest` (see `@auth/core/lib/actions/signin/send-token.js` — the callback is
awaited at line 23, the send happens at line 48). The login page shows the same "check your
email" confirmation either way, so email enumeration isn't possible — but no SMTP call is made
and no Resend quota is spent on an unregistered address.

So when testing delivery, make sure the address you use actually exists in the `User` table, or
you'll be debugging a send that was never attempted.

## Deploying an env change

`docker-compose.yml` passes `.env` via `env_file:`, so the values are **not** baked into the
image — no rebuild is needed for an env-only change. But `docker compose restart` reuses the
existing container's environment and will silently keep the old values. Recreate instead:

```bash
docker compose up -d --force-recreate app
```

Verify what the running container actually has:

```bash
docker compose exec app printenv | grep -E 'SMTP_|EMAIL_'
```

A code change (like the `sendVerificationRequest` override above) does need a rebuild:

```bash
docker compose up -d --build app
```

Note `.next/standalone/.env` is a stale build artifact from a previous `next build`. It isn't
what the container reads, and it gets regenerated on the next build.
