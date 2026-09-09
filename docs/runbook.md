# Operations Runbook

PathQuote deploys from `main` to a single VPS via GitHub Actions
(`.github/workflows/deploy.yml`). The app runs under Docker Compose
(`docker compose`) as three services — `app`, `postgres`, `gotenberg` — with
`app` bound to `127.0.0.1:3010` and Nginx reverse-proxying the public domain
`q.pathfindercut.com` in front of it.

## 1. One-time VPS setup

Run once, on a fresh VPS with Docker, Docker Compose, git, and Nginx already
installed.

1. Clone the repo to the path the deploy workflow expects:

   ```bash
   git clone git@github.com:hottabov/pathquote.git /opt/pathquote
   cd /opt/pathquote
   ```

   The deploy job runs `git pull --ff-only` from this exact path, so it must
   be `/opt/pathquote` and the working tree must stay on `main` with no local
   commits ahead of origin.

2. Create the environment file from the template and fill in real values:

   ```bash
   cp .env.example .env
   ```

   - `AUTH_SECRET` — generate with `openssl rand -base64 32`.
   - `POSTGRES_PASSWORD` — a strong random password; must match the password
     portion of `DATABASE_URL`.
   - `DATABASE_URL` — `postgresql://pathquote:<POSTGRES_PASSWORD>@postgres:5432/pathquote`
     (the `postgres` host is the Compose service name, not `localhost`).
   - `AUTH_URL` — `https://q.pathfindercut.com`.
   - `SMTP_*` / `EMAIL_FROM` — for magic-link email. Leaving `SMTP_*` blank
     disables magic-link login; password login is unaffected.
   - `GOTENBERG_URL` — `http://gotenberg:3000` (leave as-is; matches the
     Compose service name).
   - `UPLOADS_DIR` — `/data/uploads` (matches the `uploads` volume mount).

   `.env` is git-ignored and never leaves the VPS.

3. Log in to GHCR so the box can pull the images CI builds.

   The registry accepts **only a classic personal access token** — fine-grained
   tokens do not authenticate to GHCR, whatever their package permissions
   ([GitHub Docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-to-the-container-registry):
   "GitHub Packages only supports authentication using a personal access token
   (classic)"). The VPS never builds or pushes, so give it the narrowest scope
   that exists for this: `read:packages`, and nothing else.

   Create it at **github.com → Settings → Developer settings → Personal access
   tokens → Tokens (classic) → Generate new token (classic)**, or open the
   pre-scoped form directly:

   <https://github.com/settings/tokens/new?scopes=read:packages&description=pathquote-vps-pull>

   Tick **only** `read:packages` — the UI pre-selects `repo` when you touch
   `write:packages`, which would hand the box full repository access it has no
   use for. Set an expiry you will actually renew (90 days is reasonable; the
   symptom of an expired token is `docker compose pull` failing with
   `denied`). Copy the token — GitHub shows it once.

   Then on the VPS, paste it at the prompt (the `read -rs` line waits silently
   for input, so nothing is echoed and nothing lands in shell history):

   ```bash
   read -rs GHCR_TOKEN && echo
   echo "$GHCR_TOKEN" | docker login ghcr.io -u hottabov --password-stdin
   unset GHCR_TOKEN
   ```

   Expect `Login Succeeded`. The credential is stored in
   `~/.docker/config.json` and survives reboots, so this is a one-time step.

   Verify before relying on it:

   ```bash
   docker pull ghcr.io/hottabov/pathquote:latest
   ```

   (This fails with `manifest unknown` until CI has pushed at least once —
   that is a different error from `denied`, which means the token is wrong.)

   The packages are `ghcr.io/hottabov/pathquote` (the app) and
   `ghcr.io/hottabov/pathquote-tools` (migrations, seeding, operator scripts).
   Both are private by default and inherit the repository's access.

4. Pull and start the stack:

   ```bash
   docker compose --profile tools pull app tools
   docker compose up -d
   ```

   Without a `TAG` in the environment both services resolve to `:latest`,
   which is what CI tags on every successful deploy. To pin a specific build,
   `export TAG=<commit sha>` first — that is exactly what the deploy workflow
   does, and what a rollback uses (see §5).

5. Apply migrations:

   ```bash
   docker compose run --rm tools npx prisma migrate deploy
   ```

6. Seed the catalog (idempotent — safe to re-run, ~4s):

   ```bash
   docker compose run --rm tools npm run db:seed
   docker compose run --rm tools npm run db:verify-seed   # optional sanity check
   ```

7. Create the first admin user. Prefer piping the password in rather than
   typing it as a plain CLI argument — anything passed as an argv token is
   written to the shell's history file (`~/.bash_history` etc.) and is
   visible to any other process on the box via `/proc/<pid>/cmdline` while it
   runs. Two safer options, both using the existing
   `npm run user:create -- <email> <password> ADMIN AU` script:

   - **Environment variable, unset immediately after:**

     ```bash
     read -rs ADMIN_PW && echo
     docker compose run --rm -e ADMIN_PW tools sh -c \
       'npm run user:create -- you@example.com "$ADMIN_PW" ADMIN AU'
     unset ADMIN_PW
     ```

   - **Interactive shell inside the container**, typing the password at a
     prompt so it never appears in either host or container shell history:

     ```bash
     docker compose run --rm tools sh
     # inside the container:
     npm run user:create -- you@example.com "$(read -rsp 'password: ' p && echo "$p")" ADMIN AU
     exit
     ```

   Either way, clear your host shell history afterwards if the password did
   end up on the command line (`history -d <line>` or `history -c`).

8. Verify: `curl -fsS http://127.0.0.1:3010/api/health` should return
   `{"ok":true,"db":true,"schemaOk":true}`, and
   `https://q.pathfindercut.com/login` should load once Nginx and TLS are
   configured (section 3).

## 2. GitHub repository secrets

Add these under **Settings → Secrets and variables → Actions** on
`github.com/hottabov/pathquote`. The `deploy` job in
`.github/workflows/deploy.yml` reads them via `appleboy/ssh-action@v1`.

| Secret        | Value                                                          |
| ------------- | --------------------------------------------------------------- |
| `VPS_HOST`    | VPS hostname or IP                                              |
| `VPS_USER`    | SSH user with access to `/opt/pathquote` and the `docker` group |
| `VPS_SSH_KEY` | Private key for a **dedicated deploy key**                      |

For `VPS_SSH_KEY`, generate a dedicated keypair rather than reusing a
personal key (`ssh-keygen -t ed25519 -f deploy_key -N ""`), add the public
half to the VPS user's `~/.ssh/authorized_keys`, and paste the private half
into the secret. Since the workflow only needs `git pull` (read access) plus
local Docker/Prisma commands already on the box, the corresponding GitHub
deploy key (if you also register the public key as a repo Deploy Key rather
than relying on an already-cloned repo with its own remote credentials)
only needs **read access** — do not grant it write/push access.

No registry secret is needed here: the `build` job pushes to GHCR with the
workflow's own `GITHUB_TOKEN` under `permissions: packages: write`. Only the
VPS needs a credential of its own, and it is read-only (§1, step 3).

## 2b. What a deploy actually does

Since 2026-09-04 the VPS builds nothing. On a push to `main`:

1. **`ci`** — one runner, one `npm ci`: lint, typecheck, tests, then against a
   Postgres service container `prisma migrate diff --exit-code` (schema has a
   matching migration), migrate, seed twice (idempotency), `db:verify-seed`.
2. **`build`** — builds the `run` and `tools` targets on a 4-vCPU runner with
   a persistent BuildKit layer cache and pushes both to GHCR, tagged with the
   commit SHA and `latest`.
3. **`deploy`** — SSH to the VPS: `git pull` (for `docker-compose.yml` only),
   `docker compose pull`, `up -d postgres`, `prisma migrate deploy` from the
   `tools` image, `up -d app gotenberg`, then a health check that asserts both
   `"ok":true` and `"schemaOk":true` before pruning old layers.

Migrations always run before the new app starts, so the code and the schema
can never disagree in the window between them.

### Rolling back

The previous image is still on the box (the workflow's `docker image prune -f`
keeps tagged images) and every build is in GHCR by SHA:

```bash
cd /opt/pathquote
TAG=<previous commit sha> docker compose up -d app
curl -fsS http://127.0.0.1:3010/api/health
```

If that SHA's image was pruned, `TAG=<sha> docker compose pull app` first.

A rollback does **not** revert migrations. If the bad deploy migrated the
schema, roll back to a commit whose code still works against the current
schema, or restore from a dump (§4).

## 3. Nginx + TLS

Create `/etc/nginx/sites-available/pathquote`:

```nginx
server {
    listen 80;
    server_name q.pathfindercut.com;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Enable and reload:

```bash
ln -s /etc/nginx/sites-available/pathquote /etc/nginx/sites-enabled/pathquote
nginx -t && systemctl reload nginx
```

Then obtain a certificate with certbot (adds the TLS `server` block and the
HTTP→HTTPS redirect automatically):

```bash
certbot --nginx -d q.pathfindercut.com
```

Certbot's systemd timer renews automatically; confirm it's active with
`systemctl status certbot.timer`.

## 4. Backups

The live VPS runs `/usr/local/bin/pq-backup.sh` from root's crontab at 03:00.
It dumps Postgres *and* the `uploads` volume (uploaded files are not in the
database), writes each artifact to a `.tmp` path and renames it only after the
command succeeds — a dump that dies partway leaves a `.tmp` behind instead of a
truncated file that looks like a valid backup — then prunes anything older than
14 days:

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR=/opt/backups
COMPOSE=/opt/pathquote/docker-compose.yml
KEEP_DAYS=14
STAMP=$(date +%F)

mkdir -p "$BACKUP_DIR"

docker compose -f "$COMPOSE" exec -T postgres \
  pg_dump -U pathquote pathquote | gzip > "$BACKUP_DIR/pq-$STAMP.sql.gz.tmp"
mv "$BACKUP_DIR/pq-$STAMP.sql.gz.tmp" "$BACKUP_DIR/pq-$STAMP.sql.gz"

docker run --rm \
  -v pathquote_uploads:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/uploads-$STAMP.tar.gz.tmp" -C /data .
mv "$BACKUP_DIR/uploads-$STAMP.tar.gz.tmp" "$BACKUP_DIR/uploads-$STAMP.tar.gz"

find "$BACKUP_DIR" -name 'pq-*.sql.gz'      -mtime +$KEEP_DAYS -delete
find "$BACKUP_DIR" -name 'uploads-*.tar.gz' -mtime +$KEEP_DAYS -delete
find "$BACKUP_DIR" -name '*.tmp'            -mtime +1          -delete

echo "$(date -Is) backup ok"
```

Crontab entry:

```cron
0 3 * * * /usr/local/bin/pq-backup.sh >> /var/log/pq-backup.log 2>&1
```

Verify a dump is real, not just present:

```bash
gunzip -t /opt/backups/pq-$(date +%F).sql.gz
zcat /opt/backups/pq-$(date +%F).sql.gz | grep -c 'CREATE TABLE'   # expect ~19
```

`/opt/backups` sits on the same disk as the database, so it protects against a
bad migration or an accidental `DROP`, not against losing the VPS. Off-site
copies (rclone to object storage) are still TODO.

The two plain cron entries below are the minimal equivalent, kept for
reference on a host without the script.

### Nightly dump

Add to the deploy user's crontab (`crontab -e`):

```cron
0 3 * * * mkdir -p /opt/backups && docker compose -f /opt/pathquote/docker-compose.yml exec -T postgres pg_dump -U pathquote pathquote | gzip > /opt/backups/pq-$(date +\%F).sql.gz
```

### 14-day rotation

Add a second cron entry to prune anything older than 14 days:

```cron
30 3 * * * find /opt/backups -name 'pq-*.sql.gz' -mtime +14 -delete
```

(The `\%F` escaping above is required because `%` is special to cron; when
editing the crontab directly via `crontab -e` the same escaping applies.)

### Restore procedure

1. Stop the app so it isn't writing during restore (Postgres can stay up):

   ```bash
   docker compose stop app
   ```

2. Restore from a chosen dump:

   ```bash
   gunzip -c /opt/backups/pq-2026-08-29.sql.gz | \
     docker compose exec -T postgres psql -U pathquote -d pathquote
   ```

   Restoring into a database with existing tables can conflict; for a clean
   restore, drop and recreate the database first (destructive — confirm you
   have the dump you want):

   ```bash
   docker compose exec -T postgres psql -U pathquote -d postgres -c \
     "DROP DATABASE pathquote; CREATE DATABASE pathquote OWNER pathquote;"
   gunzip -c /opt/backups/pq-2026-08-29.sql.gz | \
     docker compose exec -T postgres psql -U pathquote -d pathquote
   ```

3. Bring the app back up and re-verify migrations are in sync (Prisma
   tracks applied migrations in the restored dump, so this should be a
   no-op if the dump matches the current schema):

   ```bash
   docker compose up -d app
   docker compose run --rm tools npx prisma migrate deploy
   curl -fsS http://127.0.0.1:3010/api/health
   ```

## 4b. Replacing production with your local database

Used while the tool is still being built and production holds nothing worth
keeping: it makes production an exact copy of a local machine — catalogue,
users, clients, quotes and uploaded files.

**This deletes everything currently on production**, including the accounts
people sign in with. Afterwards the only logins that exist are the ones from
the local database. If production ever holds a real quote or a real user,
stop and copy only what is needed instead — `npm run db:seed` on the VPS
already brings the catalogue across from the repository without touching a
single user.

### The command

`scripts/replace-prod-with-local.sh` is every step below in one run. From the
repository root, with the local Postgres container up:

```bash
docker compose up -d postgres
VPS=root@74.208.106.34 SSH_PORT=3498 SSH_KEY=~/.ssh/pathfinder-key ./scripts/replace-prod-with-local.sh
```

One line, no backslash — a `\` only continues a line when the newline follows
it immediately, and pasting the wrapped form into one line turns it into an
escaped space that gets prepended to the script's path.

**Deploy first.** The dump carries the local schema, so the VPS must already be
running this commit; the script stops when the two `HEAD`s differ rather than
restoring a schema the running image was never built against. Push, let the
deploy workflow go green, then run this.

It asks for `REPLACE` before touching anything, refuses to run quietly when
the VPS is on a different commit than the local HEAD (see the last paragraph
of this section for why), takes a backup of production first, and finishes on
`/api/health`. `SSH_KEY` is only needed because the VPS is key-only and that
key is not the one ssh picks by default; drop `SSH_PORT`/`SSH_KEY` entirely if
`~/.ssh/config` already carries them for this host. `VPS_DIR` (default
`/opt/pathquote`) and `UPLOADS_VOLUME` (default `pathquote_uploads`) are the
other two knobs.

Check the key reaches the box before a run that is going to drop a database:

```bash
ssh -p 3498 -i ~/.ssh/pathfinder-key -o IdentitiesOnly=yes root@74.208.106.34 "cd /opt/pathquote && git rev-parse --short HEAD"
```

### Clearing demo quotes first

Copying local over production copies the demo quotes too, and a deleted quote
is not the same thing as an unreachable one: a signing link keeps working for
as long as its `SigningRequest` row exists, and that row is invisible in the
Quotes list to everyone but the quote's own author (`documentWhereForUser`,
src/lib/scope.ts — ADMIN sees all, MANAGER sees own). A demo quote written by
another account is therefore both gone from your list and live on the web.

So purge locally, then copy:

```bash
npm run quotes:purge            # dry run — lists what would go
npm run quotes:purge -- --yes   # delete
```

That removes every `Document` (cascading to items, lines, exclusions, signing
requests and signatures), resets the per-region numbering, and deletes the
files those rows owned — archived signed PDFs and frozen signature images.
The catalogue, users, regions, settings, companies and contacts are untouched.

Then run the copy below, which makes production an exact copy of that state.
Do it in this order: purging production directly would need the script inside
the deployed `tools` image, and would leave the two machines diverged anyway.

### By hand

Two things live in different places on the two machines, which is why this is
not one command underneath:

- **Postgres** is a container on both, so it dumps and restores the same way.
- **Uploaded files** are a Docker volume on the VPS (`pathquote_uploads`,
  mounted at `/data/uploads`), but on a development machine the app runs on
  the host and `UPLOADS_DIR` is unset, so they sit in `data/uploads` inside
  the repository.

On the local machine:

```bash
cd "/path/to/PF Invoice"
docker compose exec -T postgres pg_dump -U pathquote pathquote | gzip > /tmp/pq-local.sql.gz
tar czf /tmp/uploads-local.tar.gz -C data/uploads .
scp /tmp/pq-local.sql.gz /tmp/uploads-local.tar.gz USER@VPS:/tmp/
```

On the VPS:

```bash
sudo /usr/local/bin/pq-backup.sh          # back up what is about to be replaced
cd /opt/pathquote
docker compose stop app                   # nothing may hold a connection

# WITH (FORCE) drops the database even though other sessions are attached;
# without it the DROP simply blocks.
docker compose exec -T postgres psql -U pathquote -d postgres \
  -c "DROP DATABASE pathquote WITH (FORCE);" \
  -c "CREATE DATABASE pathquote OWNER pathquote;"
gunzip -c /tmp/pq-local.sql.gz | docker compose exec -T postgres psql -U pathquote -d pathquote

# Confirm the volume name first — it follows the Compose project directory.
docker volume ls | grep uploads
docker run --rm -v pathquote_uploads:/data -v /tmp:/backup alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/uploads-local.tar.gz -C /data"

docker compose up -d app
curl -fsS http://127.0.0.1:3010/api/health
```

`.env` never leaves the VPS, so production keeps its own secrets and database
password — only data is copied. The dump carries `_prisma_migrations` with it,
so a `migrate deploy` afterwards is a no-op as long as both machines are on the
same commit; if the local machine is behind, deploy the branch first and
migrate there, then copy.

Sign in immediately afterwards and confirm an account works. The only
credentials that now exist are the local ones, and finding that out later
means being locked out of production.

## 5. Troubleshooting

**App won't respond / health check failing**

```bash
curl -fsS http://127.0.0.1:3010/api/health   # {"ok":true} expected
docker compose ps                             # all services should be "healthy"/"running"
docker compose logs -f app                    # tail app logs
docker compose logs -f postgres               # tail Postgres logs
docker compose logs -f gotenberg              # tail Gotenberg logs
```

The `/api/health` route runs `SELECT 1` against Postgres on every request
(it is never cached), so a `503` with `"db":false` almost always means the
database is unreachable or `DATABASE_URL` in `.env` is wrong — check
`docker compose logs postgres` and confirm the app's `.env` matches the
Postgres container's credentials.

The route also reports `"schemaOk"`, a separate probe (`findFirst` on
`User.phone`, `Document.showItemPrices`, and `Region.maxDiscountPct` — the
newest migrated columns) distinct from plain connectivity. `"db":true` with
`"schemaOk":false` means Postgres answers fine but the schema is stale —
migrations weren't applied for the code currently running. This is the
`{"ok":true}`-that-actually-means-broken failure mode from the 2026-08-31
incident, where migrations 4-7 never ran and every login failed with
"Invalid credentials" even though `SELECT 1` succeeded the whole time.

**If all logins fail with "Invalid credentials"** → don't assume bad
passwords. Check `docker compose logs app | grep -i prisma` for a `P2022`
(missing column) or other `P1xxx`/`P2xxx` error first — `src/auth.ts` logs
these loudly (`[auth] infrastructure error ...`) instead of masking them as
a failed login. Then check `curl -fsS http://127.0.0.1:3010/api/health` for
`"schemaOk":false` and run the manual recovery command below.

**Migrations out of sync**

```bash
docker compose run --rm tools npx prisma migrate status
```

Shows pending/failed migrations. To re-apply cleanly:

```bash
docker compose run --rm tools npx prisma migrate deploy
```

If a migration is reported as failed partway through, resolve it manually
per the Prisma CLI's guidance (`prisma migrate resolve`) before retrying —
do not re-run `migrate deploy` blindly against a half-applied migration.

**Deploy workflow fails at the SSH step**

- Confirm `VPS_HOST` / `VPS_USER` / `VPS_SSH_KEY` secrets are current and the
  public key is still in `~/.ssh/authorized_keys` on the VPS.
- Confirm `/opt/pathquote` has no local commits/changes blocking
  `git pull --ff-only` (`git status` on the VPS).

Read the log carefully before touching the secrets: two different SSH hops
fail with similar-looking errors, and only one of them involves them at all.

**`git@github.com: Permission denied (publickey)` during the deploy script**

GitHub Actions reached the VPS fine — the script is running, and it is the
VPS's own `git pull` that cannot authenticate *to GitHub*. The `VPS_SSH_KEY`
secret is not involved.

The tell is the host in the message. The pull is supposed to go through the
`github-pf` alias in the deploy user's `~/.ssh/config`, which is what points
it at `~/.ssh/pf_invoice_deploy`; a literal `git@github.com` means the alias
was bypassed and ssh offered whatever default key it had. Renaming the
repository is how this happens — the natural fix afterwards is
`git remote set-url origin git@github.com:owner/name.git`, which quietly
drops the alias.

```bash
cd /opt/pathquote
git remote -v                                            # expect github-pf:...
git remote set-url origin github-pf:hottabov/pathquote.git
ssh -T github-pf                                         # should greet the repo
```

Belt and braces, so the next rename cannot reintroduce it — this binds the
key to the repository rather than to the remote's spelling:

```bash
git config core.sshCommand "ssh -i ~/.ssh/pf_invoice_deploy -o IdentitiesOnly=yes"
```

**`Not possible to fast-forward, aborting` during the deploy script**

`main` was force-pushed (history rewritten) and the VPS still holds the old
commits, so there is no fast-forward path. `git pull` prints the old and new
tips on its `forced update` line, which names the commit the VPS is stuck on.

The VPS is a deployment checkout and must never hold work of its own, so the
resolution is to discard its history, not to merge it:

```bash
cd /opt/pathquote
git status --short          # MUST be empty; investigate anything listed
git fetch origin
git reset --hard origin/main
```

`.env` is git-ignored and survives this. Do not run `git clean` — nothing
here needs it, and it reaches files the reset deliberately leaves alone.

**Deploy workflow fails at `docker compose run --rm tools npx prisma migrate
deploy` or the final health check**

The deploy job (`.github/workflows/deploy.yml`) runs, in order: `git pull`,
`docker compose build` (images only, nothing started yet), `docker compose
up -d postgres`, `docker compose run --rm tools npx prisma migrate deploy`,
then `docker compose up -d --build` to start/update `app` and `gotenberg`,
then polls `/api/health` (up to 10 tries, 3s apart) until it sees both
`"ok":true` and `"schemaOk":true`. Migrations always run against the new
code's Postgres *before* the new app code is started, and the whole script
is `set -euo pipefail`, so a failed `migrate deploy` or a schema that still
doesn't check out after the app starts stops the job — it will never report
green while `schemaOk` is `false`.

What the deploy does **not** do is seed. Migrations reshape the schema; the
catalogue's own contents come from `prisma/seed-data/`, and nothing on this
path reads them. So a release that adds or reprices a product or an option
needs one more command on the VPS after the deploy goes green:

```bash
cd /opt/pathquote
docker compose run --rm tools npm run db:seed
```

Skipping it is not cosmetic. The EasyLoader builder, for one, writes one
option line per module role, looked up as "this width's option with this
role" (`Option.role` + `Option.parentProductId`, seeded from
`catalog.json`), and refuses the layout when a role has no row — so an
unseeded production would refuse to save an EasyLoader at all, with an
error naming an option that exists perfectly well in the repository.

- SSH in and repeat the same commands manually (`docker compose run --rm
  tools npx prisma migrate deploy`, then `curl -fsS
  http://127.0.0.1:3010/api/health`) to see the actual error before deciding
  whether to roll back.
- `docker compose logs app` for the stack trace.
- Manual recovery once the actual migration problem is fixed (e.g. after
  resolving a failed migration per the "Migrations out of sync" section
  above):

  ```bash
  docker compose run --rm tools npx prisma migrate deploy && docker compose restart app
  ```

**Rolling back a bad deploy**

```bash
cd /opt/pathquote
git log --oneline -5      # find the last good commit
git checkout <good-sha>
docker compose up -d --build
docker compose run --rm tools npx prisma migrate deploy
curl -fsS http://127.0.0.1:3010/api/health
```

Return to `main` (`git checkout main`) once a fix is pushed, so the next
automated deploy's `git pull --ff-only` succeeds.

**Testing PDF download locally (Gotenberg)**

The PDF route (`GET /api/quotes/[documentId]/quotation-pdf`, `src/app/api/
quotes/[documentId]/quotation-pdf/route.ts`) needs a reachable Gotenberg instance —
there is none in the sandbox this was built in, so this pipeline is
code-verified only until checked against a real container. To check it
locally:

```bash
docker compose up -d gotenberg
# GOTENBERG_URL=http://localhost:3001 in your local .env matches the port
# gotenberg's compose service publishes for host access; in-cluster it's
# http://gotenberg:3000, per .env.example.
npm run dev
```

Then either:

- Log in at `http://localhost:3100/login`, open any document's builder page
  or `/quotes/<id>/quotation`, and click **Download PDF** — the browser
  already carries the session cookie the route requires.
- Or, with a valid session cookie copied from the browser's dev tools
  (Application → Cookies → `authjs.session-token` or `__Secure-authjs.
  session-token`), hit the route directly:

  ```bash
  curl -v --cookie "authjs.session-token=<value>" \
    http://localhost:3100/api/quotes/<documentId>/quotation-pdf \
    -o out.pdf
  file out.pdf   # should report "PDF document"
  ```

A `502 {"error":"PDF service unavailable"}` response means the route reached
the auth/scope/render steps fine but Gotenberg itself is unreachable or
returned a non-200 — check `docker compose logs gotenberg` and confirm
`GOTENBERG_URL` in `.env` points at the right host:port. A `401` means the
cookie is missing/expired; a `404` means the document id doesn't exist or
isn't visible to that user (wrong scope) — both are indistinguishable by
design, same as the preview page.

## 6. Host environment notes (IONOS + WordOps)

The production box is an IONOS VPS running Ubuntu 22.04 with WordOps already
installed (its own Nginx build, UFW, fail2ban). That combination breaks Docker
in several non-obvious ways. Everything below is already applied on the live
host — this section exists so a rebuild does not rediscover it the hard way.

### systemd-networkd steals Docker's veth interfaces

Symptom: every container is unreachable — DNS times out, `ping` to the bridge
gateway fails, `bridge link show` is empty, and `tcpdump` on the bridge sees
nothing at all. `iptables` counters stay at zero because the packets never make
it past layer 2. `npm ci` inside a build fails with the misleading
`npm error Exit handler never called!`.

Cause: netplan generates `/run/systemd/network/10-netplan-all.network` with
`Name=*`, so systemd-networkd manages `docker0`, `br-*` and every `veth*` and
un-enslaves them from their bridge. networkd applies the *first* matching file
in lexicographic order, so an override must sort before `10-`:

```bash
cat > /etc/systemd/network/05-docker-unmanaged.network <<'EOF'
[Match]
Name=docker0 veth* br-*

[Link]
Unmanaged=yes
EOF

systemctl restart systemd-networkd
systemctl stop docker && ip link del docker0; systemctl start docker
```

Verify with `networkctl list` — Docker interfaces must read `unmanaged`, and
`bridge link show` must list a veth with `master docker0 state forwarding`.

### UFW blocks container egress

WordOps ships `DEFAULT_FORWARD_POLICY="DROP"` in `/etc/default/ufw`, which
drops forwarded container traffic. Set it to `ACCEPT` and `ufw reload`. Note
this only restores forwarding; Docker publishes ports via its own `DOCKER-USER`
chain and bypasses UFW either way, which is why `app` binds to
`127.0.0.1:3010` rather than `0.0.0.0`.

`/etc/docker/daemon.json` also pins the bridge address, since the daemon left
`docker0` without an IPv4 address on this host:

```json
{ "bip": "172.17.0.1/16" }
```

### Nginx: do not add global directives

WordOps already sets `client_max_body_size 100m` in `nginx.conf`. Adding
another one in `/etc/nginx/conf.d/` makes `nginx -t` fail with `directive is
duplicate`, which in turn makes acme.sh's `reloadcmd` fail, which makes
`wo site update --letsencrypt` report `Deploying SSL cert [KO]` even though the
certificate was issued successfully. Check `nginx -t` first whenever WordOps
fails to deploy a certificate; per-site overrides belong in
`/var/www/<domain>/conf/nginx/`.

The site itself is a WordOps proxy site:

```bash
wo site create q.pathfindercut.com --proxy=127.0.0.1:3010
wo site update q.pathfindercut.com --letsencrypt --dns=dns_cf   # or plain --letsencrypt for HTTP-01
```

DNS lives in Cloudflare with the record set to **DNS only**. If it is ever
switched to Proxied, HTTP-01 validation stops working — use `--dns=dns_cf`
(needs `CF_Token` + `CF_Account_ID` exported) and set Cloudflare's SSL mode to
Full (strict).

### SSH runs on a non-default port

WordOps moves sshd to a custom port, so the deploy workflow reads it from the
`VPS_PORT` secret (`appleboy/ssh-action` defaults to 22). Two *different* keys
are involved and they are easy to confuse:

- `~/.ssh/pf_invoice_deploy` — GitHub **deploy key**, public half registered on
  the repository, used by `git pull` on the VPS via the `github-pf` host alias
  in `~/.ssh/config`. Never goes into a GitHub secret.
- `~/.ssh/gha_pathquote` — key for **GitHub Actions to log into the VPS**,
  public half in the VPS's `~/.ssh/authorized_keys`, private half in the
  `VPS_SSH_KEY` secret.

Putting the deploy key in `VPS_SSH_KEY` produces
`ssh: handshake failed: ... [none publickey]`. `/var/log/auth.log` on the VPS
is the fastest way to tell a rejected key from a wrong port or a banned IP.

### After `npm ci`: "Cannot find module '.prisma/client/default'"

Prisma 7 dropped the automatic `prisma generate` on install, so a fresh
`npm ci` leaves `node_modules/.prisma` absent and every import of
`@prisma/client` fails at module evaluation — which, because `src/proxy.ts`
pulls in `src/auth.ts`, takes down the middleware and turns *every* route into
a 404. The Dockerfile always called `npx prisma generate` explicitly; local
installs had nothing equivalent.

Fixed by a `postinstall: prisma generate` script. If you hit it on an older
checkout, run `npx prisma generate` by hand.

That script has a consequence in the Dockerfile: `npm ci` now runs
`prisma generate`, which needs `prisma.config.ts` and `prisma/schema.prisma` to
be present. The `deps` stage previously copied only `package*.json`, so the
build died with `Could not find Prisma Schema` inside `RUN npm ci`. It now
copies those two files as well — deliberately not the whole `prisma/`
directory, so that a migration or a `seed-data/` edit doesn't invalidate the
`npm ci` layer. If you add another install-time dependency on a repo file,
it has to be copied there too.

Verify a change to that stage without a full deploy:

```bash
docker build --target deps -t pq-deps-check .
```

Related: `node_modules` holds platform-specific native binaries
(`@node-rs/argon2-*`, `@next/swc-*`, `lightningcss-*`). Running `npm install`
against the same working tree from a different OS — a Linux container sharing
the folder, say — makes npm re-resolve optional dependencies for *that*
platform and drop the host's. Symptom: `Cannot find native binding`. Recovery
is `rm -rf node_modules .next && npm ci` on the host.

### CI type-checking needs generated route types

Next.js 16 generates `LayoutProps`/`PageProps` into `.next/types` during
`next dev`/`next build`, so a bare `tsc --noEmit` in CI fails with
`TS2304: Cannot find name 'LayoutProps'`. The `typecheck` script therefore runs
`next typegen && tsc --noEmit`.

### Creating the first admin: watch the password argument

`scripts/create-user.ts` sets `passwordHash` only when a non-empty password is
passed, and silently creates a login-less user otherwise. `read -rs ADMIN_PW`
creates a *shell* variable while `docker compose run -e ADMIN_PW` forwards from
the *environment*, so the password arrives empty unless it is exported — and
pasting the `read` line together with the following lines makes `read` consume
the next line instead of the typed password. Always confirm afterwards:

```sql
select email, active, ("passwordHash" is not null) as has_pw from "User";
```

## 7. Manager isolation

A MANAGER sees only the clients and quotes they created, and only their own
region's catalogue prices. Two operational rules make that true.

### Every manager needs an active region

A manager whose `regionId` is null — or whose region has since been
deactivated or deleted — is redirected to `/no-region` and can reach only
Account and PathQuote Support. Assign the region when creating the account.

There is no fallback region. Quotes used to default silently to AU's
currency and tax rate for a region-less author; `createDraft` now refuses
instead. Deactivating a region therefore locks out every manager assigned to
it, by design — reassign them first:

```sql
select u.email, r.code, r.active
from "User" u left join "Region" r on r.id = u."regionId"
where u.role = 'MANAGER';
```

### Catalogue visibility is per user and defaults to "sees everything"

Hiding a product from a manager is done at `/settings/users/<id>`, one user
at a time. A newly created manager sees the whole catalogue until someone
hides what should be hidden.

This is deliberate — hiding a product is the exception, not the rule — but it
means an admin creating an account in a region that has hidden products must
set that up by hand. Nothing warns you.

### After changing a manager's region

Changing `User.regionId` re-homes none of that manager's existing companies.
They keep owning companies filed in the old region, and the client card will
now show that region and refuse to save (`That region is not available to
you.`) until an admin moves the company or restores the manager's region.
That refusal is intentional: the alternative silently rewrote the company's
region, and with it its currency and tax rules, on any unrelated edit.

```sql
select c.name, r.code as company_region, ur.code as owner_region
from "Company" c
  join "Region" r on r.id = c."regionId"
  join "User" u on u.id = c."ownerId"
  left join "Region" ur on ur.id = u."regionId"
where u.role = 'MANAGER' and r.id is distinct from ur.id;
```

An empty result means no manager owns a company outside their own region.

### Re-checking isolation after a change

`tests/scope-coverage.test.ts` fails the build if a module under
`src/lib/queries/` or `src/lib/actions/` queries `db.company`, `db.document`
or `db.price` without importing `@/lib/scope`. That catches a forgotten
filter, not a wrong one.

For the rest, the adversarial script lives in
`docs/superpowers/plans/2026-09-06-manager-permissions.md`, Task 11: two
managers, one attempting the other's ids by direct URL and by replayed
server-action POST. Every attempt must return 404 or an error, never a 200 —
a 403 is itself a finding, because it confirms the row exists. Re-run it
after any change to `src/lib/scope.ts`, `src/lib/authz.ts`, or the Settings
layout guards.

## 8. Quote signing

A manager signs a FINAL quote from a signature saved on their profile
(`/settings/account`), sends it to the client at a tokenised `/sign/<token>`
link, and the client signs it back. Completion writes an archived PDF and its
SHA-256 to `Document.signedPdfName`/`signedPdfSha256`. The whole feature is
built as pure rule modules under `src/lib/signing/` plus thin server actions
in `src/lib/actions/signing.ts` (manager side) and
`src/lib/actions/signing-client.ts` (the unauthenticated client side, reached
from the public `/sign` route added to `PUBLIC_PATHS` in `src/proxy.ts`) —
start there for the actual transition rules
(`src/lib/signing/state.ts`) before changing behaviour described below.

### The four emails

| To | When | Contents | Reply-To |
|---|---|---|---|
| Client | manager presses **Send to client** (`sendQuoteForSignature`) | The `/sign/<token>` link, as a button — the raw URL is never visible HTML text, only in the plain-text part | Author, via `resolveReplyTo()` |
| Client | client presses **Confirm** (`completeSigning` → `sendCompletionEmails`) | The archived PDF as an attachment — the client has no account and their link expires | Author, via `resolveReplyTo()` |
| Author | client presses **Confirm** (`completeSigning` → `sendCompletionEmails`) | A link back into the app (`/quotes/<id>`) — no attachment, the author already has full access | None — a message to yourself needs no Reply-To |
| Client | manager presses **Revoke link** (`revokeSigningLink`) | "This quote is no longer current; your manager will be in touch" — no reason given | Author, via `resolveReplyTo()` |

Templates are pure functions in `src/lib/email/signing.ts`. All four failures
are logged with a `[signing] ... failed` prefix (`grep` for it in
`docker compose logs app`), but **the send and the invite are handled
asymmetrically, on purpose**:

- If the **invite** email fails, `sendQuoteForSignature` undoes the send: the
  just-created `SigningRequest` is re-revoked and `signingStatus` is put back
  to what it was. The manager sees "The quote could not be emailed. Nothing
  was sent — try again," and pressing Send again is the correct fix — nothing
  needs manual cleanup.
- If the **revoke** notice, or either **completion** email, fails, nothing is
  rolled back. By the time those sends are attempted the link is already dead
  (revoke) or the quote is already SIGNED (completion) — undoing either would
  contradict something that already happened. If a completion email is
  missing, see the troubleshooting table below for the manual recovery.

### Where archived PDFs live, and why deletion can't orphan them

Archived PDFs sit in the same directory as every other upload — `UPLOADS_DIR`
(`/data/uploads` on the VPS, the `pathquote_uploads` volume; `data/uploads` in
a local checkout) — named `<uuid>.pdf` and recorded in
`Document.signedPdfName`. Verify one against its recorded digest:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c \
  "select \"number\", \"signedPdfName\", \"signedPdfSha256\" from \"Document\" where id = '<documentId>';"

docker run --rm -v pathquote_uploads:/data:ro alpine \
  sh -c "sha256sum /data/<signedPdfName>"
```

The two hashes must match exactly. If the file is missing entirely, that is
its own row in the troubleshooting table below.

A signed quote's document cannot be deleted by a MANAGER or an ADMIN, ever.
`deleteDraft` (`src/lib/actions/documents/lifecycle.ts`) only ever touches a
DRAFT, `unfinalizeDocument` refuses once `signingStatus === "SIGNED"`, and
SIGNED implies `status === "FINAL"` (enforced by the
`Document_signed_implies_final` CHECK constraint added in migration
`z35_quote_signing`) — and the separate `deleteDocument` action
(`src/lib/actions/documents/lifecycle.ts`, wired to the Delete icon on the
`/quotes` list) checks `canDeleteDocument` (`src/lib/signing/state.ts`)
*before* its "FINAL requires admin" rule, refusing any SIGNED document for a
MANAGER or an ADMIN with "This quote was signed by the client and is a
permanent commercial record. It cannot be deleted."

**One role is the exception: a DEVELOPER can delete a SIGNED quote.** This
was added as a testing affordance — clearing a signed quote out of a
test/staging environment without a database console — and it is the one
right a DEVELOPER has that an ADMIN does not (see `isDeveloperRole` and the
`Role` enum's own comment in `schema.prisma`). It is not a routine operation:
the delete confirmation a developer sees on `/quotes` for a signed quote is
its own, more explicit warning, distinct from the ordinary delete prompt,
naming what is about to be destroyed and stating it cannot be recovered.

The archived PDF still cannot be silently orphaned, either way: a MANAGER or
an ADMIN simply cannot remove the row that references it
(`Document.signedPdfName`/`signedPdfSha256`), and when a DEVELOPER does
remove it, `deleteDocument` itself deletes the referenced files as part of
the same action — the archived PDF and both `Signature.imageUrl` files (the
author's and the client's frozen copies) — logging a `[signing] developer
deleted a signed quote` line with the quote number, document id and acting
user's id first. There is accordingly still no cleanup job for these files:
either the row survives, or the developer deletion took the files with it.
If a `[signing] failed to delete ...` line appears in the logs afterward, the
row is already gone (the delete itself always succeeds first) and the named
file is what's left on disk — safe to remove by hand once you've confirmed
which file it is.

The reasoning for refusing MANAGER and ADMIN is the same one `canUnfinalize`
already applies one section below: both signatures attest to the exact
archived PDF, so an ADMIN who cannot *reopen* a signed quote should not be
able to destroy the same record by deleting it instead — reopening and
deleting are two routes to the same loss of the signed commercial record.
DEVELOPER's exemption from that rule is deliberate and narrow: it exists for
testing, not for correcting or discarding a real signed quote.

The nightly backup (§4) still matters here — it is what protects every other
irreplaceable row in Postgres, and a `SIGNED` document is no exception if its
data is ever lost outside the application entirely (a bad migration, a manual
`DELETE` run directly against Postgres, a botched restore) — but it is no
longer standing in for an application-level guard against deletion through
the app itself. If a signed quote's rows are ever missing and `deleteDocument`
was not the cause, restore `Document`/`Signature`/`SigningRequest` from the
matching Postgres dump — the uploads tarball from the same night still has the
PDF file itself, since that backup runs against the volume, not against live
application state.

### A signed quote cannot be reopened

Once `signingStatus` is `SIGNED`, `unfinalizeDocument` refuses with "A signed
quote cannot be reopened. Create a new quote instead." — `canUnfinalize` in
`src/lib/signing/state.ts` is the one place this is decided, and it is
deliberate: both signatures attest to the exact archived PDF, and editing the
underlying document after that would make the signed record describe a quote
that no longer exists. There is no clone-to-revision feature (v1 explicitly
left it out — see the design doc's "Out of scope"), so when someone asks to
revise a signed quote, the honest answer is a new quote, not a reopened one.

### How to revoke and resend

**Revoke** (the ✖ "Revoke link" button on a SENT/VIEWED quote, `canRevoke` in
`src/lib/signing/state.ts`) only shows while a link is actually outstanding —
it disappears the moment the client completes or declines, and is refused
server-side too if either happens in the same instant the button is pressed.
The confirmation is explicit about the one-way part: "The client's link stops
working immediately, even if they have it open right now." Concretely, the
client's next action against that token — opening the page, hitting Print —
gets the same "no longer available" screen as an expired or foreign one, and
they're emailed the withdrawal notice (previous section) unless that send
itself fails (logged, not retried automatically — tell the client yourself if
you need to be sure they know).

**Resend** is just pressing **Send to client** again. `canSendToClient`
permits sending from `NOT_SENT` and from `DECLINED` — a declined quote does
not need to be revoked first, since there is no live link to kill — but
refuses while a link is still `SENT`/`VIEWED` ("This quote is already with
the client. Revoke the link first.") and refuses forever once `SIGNED`. A
resend always mints a fresh token and a new `SigningRequest` row; the
previous request (if the quote was revoked rather than declined) was already
revoked when the new one was created, so there is never a moment where two
links both work.

### The `signing.linkValidityDays` setting

`/settings/preferences` (ADMIN only), "Signing link validity (days)", 1–90,
default 30. **The mistake to watch for:** the value is read once, at the
moment a link is issued, and frozen onto that `SigningRequest.expiresAt`
(`sendQuoteForSignature`, `src/lib/actions/signing.ts`). Lowering — or
raising — the setting afterwards changes nothing about links already sent; it
only takes effect on the next Send. If a manager insists a client's link
should still be valid because "we just changed it to 90 days," check what the
setting actually was at that request's `sentAt`, not what it is now:

```sql
select "sentAt", "expiresAt", "expiresAt" - "sentAt" as validity
from "SigningRequest"
where "documentId" = '<documentId>'
order by "sentAt" desc;
```

### `AUTH_URL`

The emailed link is built as `${AUTH_URL}/sign/<token>` — this is Auth.js
v5's `AUTH_URL` (§1), not `NEXTAUTH_URL`. `sendQuoteForSignature` validates it
*before* generating a token or writing a row (`resolveSigningBaseUrl`,
`src/lib/actions/signing.ts`): if `AUTH_URL` is unset, blank, or not a
syntactically valid `http(s)` URL, Send fails immediately with an on-screen
error and nothing is sent — that failure mode is caught by us, at send time.

What that check cannot catch is `AUTH_URL` being syntactically fine but
*wrong* — pointing at a decommissioned domain, an internal-only hostname, or
a stale value left over from a migration. A malformed-but-parseable value
like that produces a perfectly deliverable email containing a dead link, and
nothing on the server ever visits `/sign/<token>` itself to notice. That
failure is discovered by the client, when they click it — which is why, if a
client reports a broken link and the token itself checks out in the database
(not expired, not revoked), the next thing to check is not the token but
whether `AUTH_URL` in `.env` actually resolves to `https://q.pathfindercut.com`:

```bash
docker compose exec app printenv AUTH_URL
```

### Troubleshooting

| Symptom | Cause |
|---|---|
| Client reports a 404 (or a "not available" page) on their signing link | By design, indistinguishable causes: an unknown token, or a live one that has since expired, been revoked, been declined, or already completed under a different device. `getDocumentForSigning` and `resolveLinkState` (`src/lib/signing/link.ts`) deliberately return the same non-committal state for all of them so a foreign or dead token can never be told apart from someone else's live one. Look the token's `SigningRequest` up by document to find out which it actually is (`revokedAt`, `declinedAt`, `expiresAt` vs now). |
| Client says the link expired | Check that request's own `expiresAt` (query above) — it was frozen from whatever `signing.linkValidityDays` was *at send time*, not today's value. |
| Manager can't press Send and doesn't know why | The on-screen message always names the specific reason — `canSendToClient` in `src/lib/signing/state.ts` returns one of: not FINAL yet, no author signature yet, the contact has no email, a link is already outstanding (revoke it first), or the quote is already SIGNED. If instead the error mentions `AUTH_URL`, see that section above — nothing was sent. |
| A completion email never arrived | The two completion emails (client + author) are sent independently and are best-effort — `grep -i '\[signing\] completion email failed' ` in `docker compose logs app` to see which one and why. The signing itself already succeeded regardless (`signingStatus` is already `SIGNED`), so this is never a "did it complete" question — only a "did the notice arrive" one. For the client's missing copy specifically: the archived PDF is still on disk and its hash is still in `Document.signedPdfSha256`; verify it (previous section) and send it manually rather than trying to trigger a resend, since there is no resend action for this email. |
| The archived PDF is missing from disk | `signedPdfName`/`signedPdfSha256` are only ever written together, by `completeSigning`, and enforced by the `Document_signed_pdf_pair` CHECK constraint (migration `z35_quote_signing`) — so a `SIGNED` row with a name but no file on disk means the file and the database have drifted apart, not that the write half-failed. The client's own Print button and the `/sign/[token]/pdf` route fail closed (404, logged as `"[signing] archived PDF missing on disk"`) rather than silently falling back to a live re-render — a live render could legitimately show different numbers today than what was actually signed, which would be worse than an error. Usual cause: `UPLOADS_DIR` pointing somewhere different than it did at completion time, or a Postgres restore (§4) done without the matching `uploads-*.tar.gz` from the same backup run — restore both together, always, exactly as the backup script writes them together. |
