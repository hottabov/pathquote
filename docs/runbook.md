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
3. **`deploy`** — SSH to the VPS: `git pull` (for `docker-compose.yml`; the
   `scripts/ops/` files that §4 to §4e install by hand arrive with it too),
   `docker compose pull`, `up -d postgres`, `prisma migrate deploy` from the
   `tools` image, `up -d app gotenberg`, then a health check that asserts both
   `"ok":true` and `"schemaOk":true` before pruning old layers.

Migrations always run before the new app starts, so the code and the schema
can never disagree in the window between them.

### What each image carries

Three images come out of one Dockerfile and they are deliberately not the
same tree:

- **`run`** (the app) — `.next/standalone` (Next's own traced subset of
  node_modules), the static assets, the generated Prisma client and
  `prisma/schema.prisma`. No `node_modules` of its own, no migrations, no
  seed data.
- **`tools`** (migrations, seeding, operator scripts) — a production-only
  `node_modules` (`npm ci --omit=dev`, then `@next/swc-*`, `next`, `sharp`
  and `@img` deleted in the same layer), plus `prisma/`, `scripts/` and
  `src/`. `tsx` and `dotenv` are in `dependencies`, not `devDependencies`,
  so they survive that prune: every operator script runs under tsx and
  `prisma.config.ts` imports `dotenv/config` at load time.
- **`deps` / `prod-deps` / `build`** — never pushed; they exist to produce
  the two above.

This matters because the VPS pulls at ~500 KB/s (measured 2026-09-21), so
every megabyte in `tools` is paid again on every deploy that changes
dependencies. The prune took that image's dependency layer from ~325 MB to
~144 MB gzipped (measured on a linux/amd64 install, so approximate) — well
over half, or about six minutes of that link.

Four deletions by hand, none of them guesses. `@next/swc-*` is the Rust
compiler `next build` shells out to. `next` is the framework — the image
runs no server; `app` does that from its own standalone bundle. `sharp` and
`@img` are the app's image pipeline (`images:import` copies files, it never
resizes one). `tests/tools-image-imports.test.ts` holds that line: it walks
the import graph of every `tsx` script in package.json and fails if one
reaches a deleted package, so a future script that imports `next` is caught
by CI rather than by a deploy.

Two neighbours that look equally droppable are not: `@prisma/studio-core`
and `@prisma/dev` are ~60 MB of apparent dead weight, but removing them
breaks the Prisma CLI outright (`Cannot find module
'@prisma/studio-core/data/bff'`) — so `prisma migrate deploy` stops working.
Before deleting anything else, run every `tsx` script in package.json
against the pruned tree with an unreachable `DATABASE_URL`: a real failure
says `Cannot find module`, a healthy one says `P1001`.

Anything the seed or the scripts read at runtime must live under `prisma/`,
`scripts/` or `src/`. `docs/` is in `.dockerignore` and never reaches an
image: `prisma/seed.ts` imported its retire-list from
`docs/reference/catalog-v2-target.json` until 2026-09-21, which made
`db:seed` fail in the container while passing in CI — CI seeds from the
checked-out repo, not from the image. The file now lives in
`prisma/seed-data/` with the rest of the seed input.

### Rolling back

The previous image is still on the box (the workflow's `docker image prune -f`
keeps tagged images) and every build is in GHCR by SHA:

```bash
cd /opt/pathquote
systemctl disable --now pq-act-sync.timer     # first, always — see below
systemctl disable --now pq-act-drain.timer    # likewise, once §4d's units are installed
TAG=<previous commit sha> docker compose up -d app
curl -fsS http://127.0.0.1:3010/api/health
git checkout <previous commit sha>            # only if the checkout moves too
```

If that SHA's image was pruned, `TAG=<sha> docker compose pull app` first.

**Stop the sync timer before the image moves**, and leave it off until the box
is back on code that knows `--trigger=schedule`. `pq-act-sync.sh` picks its
image with `TAG=$(git rev-parse HEAD)` in `/opt/pathquote` (§4c), so the nightly
run follows *the checkout*, not the container `docker compose up -d app`
started — which cuts both ways:

- roll the app image back and leave the checkout where it is, and the 03:00 run
  still runs the new code against the rolled-back app;
- roll the checkout back past the commit that added the flag, and the run exits
  2 — bad arguments — at 03:00 **every night**, emailing the director each time
  (`OnFailure=pq-backup-alert@%n.service`). Loud and diagnosable rather than
  dangerous, and entirely avoidable with the one line above.

Re-enable it with `systemctl enable --now pq-act-sync.timer` once the box is
forward again; `disable --now` is permanent until somebody says otherwise, and a
silently un-synced week is the failure this ordering trades for.

Do **not** remove `pq-backup-alert@.service` or `/usr/local/bin/pq-backup-alert.sh`
as part of a rollback. All three units — both backup timers and the sync — name
that one alert unit in `OnFailure=`, so removing it leaves the backups unable to
tell anybody they failed, which is worse than anything being rolled back. The
versions this branch installs are backward compatible: the script flavours
itself from the failed unit's name and `pq-backup*` still gets the backup
wording and the backup log, so the older backup units keep working against it
unchanged.

A rollback does **not** revert migrations. If the bad deploy migrated the
schema, roll back to a commit whose code still works against the current
schema, or restore from a dump (§4).

**Rolling back past the ACT! write-back (§4d).** Switch sending off first
("The switch", §4d), so nothing writes to ACT! while the box moves, then the
block above — `pq-act-drain.timer` included: it runs the checkout's image too,
and code from before the write-back has no `act:drain`, so every tick would
fail. `z65_act_outbox` stays applied, and older code runs against it unchanged:
its columns are nullable, nothing before it reads them, and the `ActOutbox`
table is simply not used. Quotes finalised, signed or accepted on the older
code queue nothing; the rows already queued wait, untouched, for the
write-back to come back.

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

## 3b. Performance settings for nginx and Postgres (2026-10-16)

From the technical audit (docs/technical-audit/). Three facts about the live
box drove these: the access log carries no request time, so a slow request
leaves no trace; `proxy_read_timeout` is nginx's compiled-in 60 s (set
nowhere in the configuration, §4c); and the per-site file is a WordOps
template, not the block in §3. Edit the per-site file
(`/var/www/q.pathfindercut.com/conf/nginx/*.conf`, §6), then `nginx -t &&
systemctl reload nginx`.

1. **Timings in the access log.** Put the `log_format` in the `http` context
   (`/etc/nginx/conf.d/pathquote-log.conf`), the `access_log` in the server
   block:

   ```nginx
   log_format pq_timing '$remote_addr [$time_local] "$request" $status $body_bytes_sent '
                        'rt=$request_time urt=$upstream_response_time';
   ```

   ```nginx
   access_log /var/log/nginx/q.pathfindercut.com.timing.log pq_timing;
   ```

   `rt=` is the number `src/app/api/client-timing/route.ts` has referred to
   since 2026-10-01 and that did not exist until now. Percentiles:

   ```bash
   grep -oE 'rt=[0-9.]+' /var/log/nginx/q.pathfindercut.com.timing.log | cut -d= -f2 | sort -n | awk '{a[NR]=$1} END{print "n="NR, "p50="a[int(NR*.5)], "p95="a[int(NR*.95)], "p99="a[int(NR*.99)], "max="a[NR]}'
   ```

2. **Keep-alive to the app.** Without it every proxied request opens a new
   TCP connection to Node. In the `http` context:

   ```nginx
   upstream pathquote_app {
       server 127.0.0.1:3010;
       keepalive 16;
   }
   ```

   and in the `location /` block, `proxy_pass http://pathquote_app;` plus
   `proxy_http_version 1.1; proxy_set_header Connection "";`.

3. **Immutable static assets.** Next's hashed files under `/_next/static/`
   never change under the same name:

   ```nginx
   location /_next/static/ {
       proxy_pass http://pathquote_app;
       proxy_http_version 1.1;
       proxy_set_header Connection "";
       add_header Cache-Control "public, max-age=31536000, immutable";
   }
   ```

   Leave `proxy_read_timeout` at 60 s: the app is now built so that nothing a
   user clicks waits on Gotenberg or ACT! inside the request.

4. **Postgres.** `docker-compose.yml` now starts Postgres with
   `pg_stat_statements` preloaded, statements over 500 ms logged, lock waits
   and I/O timing on. One-time, after the first deploy that carries it:

   ```bash
   docker compose exec -T postgres psql -U pathquote -d pathquote -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
   ```

   Then the ten most expensive statements of the day:

   ```bash
   docker compose exec -T postgres psql -U pathquote -d pathquote -c "SELECT calls, round(mean_exec_time) AS mean_ms, round(total_exec_time) AS total_ms, left(query, 90) FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;"
   ```

5. **App-side numbers.** `/api/health` now returns `dbMs` (the `SELECT 1`
   round trip) and `pool` (`total`, `idle`, `waiting` connections). The app
   logs `[runtime] event-loop p99=…` once a minute only when the Node event
   loop stalls or a query is waiting for a connection, and `[slow-query]`
   lines when `PRISMA_SLOW_MS` is set in `.env` (start with `PRISMA_SLOW_MS=500`).

## 4. Backups

Set up 2026-09-29 (source in `scripts/ops/`, installed on the VPS). One
script, two schedules:

| | Database | Uploaded files |
|---|---|---|
| Unit | `pq-backup-db.timer` → `pq-backup.sh db` | `pq-backup-files.timer` → `pq-backup.sh files` |
| When | daily 04:00 Australia/Melbourne | Saturdays 04:30 Australia/Melbourne |
| File | `/opt/backups/pq-<UTC stamp>.sql.gz` | `/opt/backups/uploads-<UTC stamp>.tar.gz` |
| Check | gzip integrity, at least 10 `CREATE TABLE`s | gzip integrity |
| Kept | 30 days | 30 days |

Both timers are DST-aware and catch up at next boot after a missed run; the
two jobs share a lock and take turns. After each run `/opt/backups` is
mirrored with `rclone sync` to `gdrive:PathQuote/backups` (Google account
pathfindermarketingdept@gmail.com), so Drive holds exactly the local files and
local rotation is Drive rotation. Deletions skip the Drive trash; at most 6
per run, so an emptied `/opt/backups` cannot wipe Drive. A failed run starts
`pq-backup-alert@<unit>.service`, which emails marketing@pathfindercut.com
through the app's SMTP account (`SMTP_*`, `EMAIL_FROM` in `.env`). Logs: the
backups write `/var/log/pq-backup.log`; the alert unit answers for the ACT!
sync, the ACT! drain and the Monday report as well now (§4c to §4e), so it
writes its own `/var/log/pq-alert.log` rather than putting "alert sent: ACT!
sync FAILED" in the middle of the backup log. Every one of these logs is
rotated by `/etc/logrotate.d/pathquote` (§4d, "Log rotation").

```bash
systemctl list-timers 'pq-backup*'           # next runs
systemctl start pq-backup-db.service         # dump now (do this before a risky migration)
systemctl start pq-backup-files.service      # uploads now
tail /var/log/pq-backup.log                  # "db backup ok: ..." / "files backup ok: ..."
rclone lsl gdrive:PathQuote/backups
/usr/local/bin/pq-backup-alert.sh --test     # check the failure email still arrives (backup wording; §4c for the sync one)
tail /var/log/pq-alert.log                   # "alert sent to ...: <subject>"
```

Installing or updating from the repository:

```bash
scp -P 3498 scripts/ops/pq-backup.sh scripts/ops/pq-backup-alert.sh root@74.208.106.34:/usr/local/bin/
scp -P 3498 scripts/ops/pq-backup-*.service scripts/ops/pq-backup-*.timer root@74.208.106.34:/etc/systemd/system/
ssh -p 3498 root@74.208.106.34 'chmod 700 /usr/local/bin/pq-backup*.sh && systemctl daemon-reload && systemctl enable --now pq-backup-db.timer pq-backup-files.timer'
```

rclone config: `/root/.config/rclone/rclone.conf`, remote `gdrive`, mode 600.
Since 2026-09-29 it uses Pathfinder's own Google Cloud OAuth client (Desktop
app, project owned by pathfindermarketingdept@gmail.com), not rclone's shared
one, which Google retires during 2026. If the token is ever revoked, the
OAuth client must be of type **Desktop app** -- a "Web application" client fails with
`Error 400: redirect_uri_mismatch`, because rclone listens on
`http://127.0.0.1:53682/`. Re-authorize with
`rclone authorize "drive" "<client_id>" "<secret>"` on a machine with a
browser, then put `client_id`, `client_secret` and the new `token` into the
config. The Google Cloud OAuth consent screen must be **In production**, not
Testing — a Testing app's refresh token expires after 7 days, and every
weekly run would fail.

Restore from Drive: `rclone copy gdrive:PathQuote/backups/<file> /tmp/`, then
follow "Restore procedure" below.

### Restore procedure

1. Stop the app so it isn't writing during restore (Postgres can stay up):

   ```bash
   docker compose stop app
   ```

2. Restore from a chosen dump:

   ```bash
   gunzip -c /opt/backups/pq-2026-09-28T2340Z.sql.gz | \
     docker compose exec -T postgres psql -U pathquote -d pathquote
   ```

   Restoring into a database with existing tables can conflict; for a clean
   restore, drop and recreate the database first (destructive — confirm you
   have the dump you want):

   ```bash
   docker compose exec -T postgres psql -U pathquote -d postgres -c \
     "DROP DATABASE pathquote; CREATE DATABASE pathquote OWNER pathquote;"
   gunzip -c /opt/backups/pq-2026-09-28T2340Z.sql.gz | \
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

## 4b. Production is live — never replace its database

Since 2026-09-28 production holds real quotes, users and clients. **Its
database is never dropped, restored from a development machine, or purged.**
`scripts/replace-prod-with-local.sh` (which did exactly that) is deleted; its
last run also started a stale `:latest` image against the new schema and took
every catalogue page down with `P2022` until the sha-tagged image was started.

How changes reach production now:

- **Code and schema** — push to `main`. The deploy workflow runs
  `prisma migrate deploy` before starting the new image (§2b).
- **Catalogue data** (new products, renamed options, prices, part numbers) —
  a migration, like `z53_catalog_review_tools_and_l_series`. Keyed by code,
  idempotent, safe to run on a database that already has live quotes.
  Retire a product or option with `active = false` rather than `DELETE`:
  quote lines keep their own snapshot, but price rows and compatibility
  cascade away with the row, and a revision or re-quote may still need it.
- **Anything that deletes or rewrites existing `Document` rows** — does not
  ship. A migration that has to touch live quotes needs a backup taken first
  (`systemctl start pq-backup-db.service`) and an explicit decision, not a deploy.
- **Images** — `scripts/push-images-to-prod.sh`, below.

### Copying catalogue images to production

```bash
# dry run: lists the image files production does not have yet
VPS=root@74.208.106.34 SSH_PORT=3498 SSH_KEY=~/.ssh/pathfinder-key ./scripts/push-images-to-prod.sh
# copy them
VPS=root@74.208.106.34 SSH_PORT=3498 SSH_KEY=~/.ssh/pathfinder-key ./scripts/push-images-to-prod.sh --yes
```

It copies only `png/jpg/jpeg/webp/svg` files from `data/uploads` that are not
already in the `pathquote_uploads` volume. It never touches the database,
never deletes a file and never overwrites one (upload names are random UUIDs,
so an existing name is the same file), and never copies PDFs — the archived
signed quotes live in the same volume — or the `derived/` thumbnail cache.

A copied image only shows up once a production row points at it. Uploading a
product photo in the local admin sets `imageUrl` in the local database only,
so ship that as part of the catalogue migration (or set it in the production
admin).

### Demo quotes on a development machine

`npm run quotes:purge` (dry run) / `npm run quotes:purge -- --yes` clears
quotes and resets numbering on a **local** database. It refuses to run unless
`DATABASE_URL` points at localhost.

## 4c. Nightly ACT! sync

PathQuote imports contacts and companies from the company's ACT! Premium CRM.
Added 2026-10-09; until then it ran only when a developer typed
`npm run act:sync`. Since the write-back (§4d), every run that writes first
sends ACT! the quotes queued for it, while sending is switched on, and only
then reads. Source in `scripts/ops/`, installed on the VPS the same way
the backups are (install lines below). One script, one schedule:

| | ACT! contact sync |
|---|---|
| Unit | `pq-act-sync.timer` → `pq-act-sync.service` → `pq-act-sync.sh` |
| When | daily 03:00 Australia/Melbourne, exactly on the hour |
| Runs | `docker compose run --rm -T tools npm run act:sync -- --trigger=schedule` in `/opt/pathquote`, with `TAG` exported from `git rev-parse HEAD` |
| Sends | first, the quotes queued for ACT! (§4d), if sending is switched on — at 03:00 normally none, because the 15-minute drain has sent them through the day |
| Reads | then, what changed in ACT! since the stored position — one night of edits is a page or two of 200 contacts, a few seconds |
| Log | `/var/log/pq-act-sync.log`, one `act:sync start`/`act:sync ok` line per run, both naming the image SHA |
| Record | every run writes itself into a `Setting` row, shown at `/settings/act-sync` — what its drain sent included |

The timer is DST-aware and catches up at next boot after a missed run
(`Persistent=true`), like the backup timers, and sits an hour before the 04:00
dump so that on an ordinary night — a night's delta, seconds to a minute or two
— the dump captures what the sync imported. On a slow-ACT! night it does not:
the delta's ordinary bad case is ~43 minutes and its ceiling ~2h16m (see "Sync
now", and what bounds it, below), so the 04:00 dump can start with a sync still
running. That costs the dump nothing — `pg_dump` reads a single MVCC snapshot,
so it captures a consistent database whether the sync has finished, not started
or is halfway through; it only means that night's ACT! changes may appear in the
next dump rather than this one. The hour is exact on purpose:
there is no `RandomizedDelaySec`, because the Settings page prints the schedule
to the director in words ("Every night at 3:00 am, Melbourne time.") and jitter
would make that sentence either untrue or vague. The comment beside
`OnCalendar` says so — do not add it back without reading it.

There is no `flock` here, unlike `pq-backup.sh`. One sync at a time is enforced
inside the worker instead, as a Postgres session advisory lock (`SYNC_LOCK_KEY`
in `src/lib/act/sync.ts`), because the **Sync now** button in Settings starts
the same work from inside the `app` container — a file lock on this box would
hold off a second copy of the script and leave the button free to run on top of
the nightly import. A run that writes takes the drain's lock as well
(`DRAIN_LOCK_KEY`, §4d) and holds both for the whole run, drain and read, so no
other drain can create a contact in ACT! between them for the read to import a
second time. The nightly run waits up to 15 minutes for a drain that has it
(`DRAIN_LOCK_WAIT_MS`); a pass is over in about 10 at worst.

A failed run starts the same alert unit the backups use (§4) —
`OnFailure=pq-backup-alert@%n.service`, so the instance it is handed is this
unit's own name, `pq-act-sync.service` — which emails
marketing@pathfindercut.com through the app's SMTP account. The alert is
flavoured by that name rather than being backup-specific any more: a sync
failure gets the subject `[PathQuote] Nightly ACT! sync FAILED on` the
hostname, tails `/var/log/pq-act-sync.log` rather than the backup log, and says
what the failure costs — ACT! and PathQuote have drifted, the next run picks up
the changes, backups are unaffected. The alert's own output goes to
`/var/log/pq-alert.log`.

### Look at the Settings page before any log

`/settings/act-sync` shows when the last run started, what it did — the quotes
its drain sent included — whether anything needs a person, the nightly
schedule, and how far through ACT!'s own edit history PathQuote has read. Its
**Quotes for ACT!** card, about the queue rather than any run, is §4d's.

**Who can reach it.** Every ADMIN and DEVELOPER, by role, always. Anybody else
— a MANAGER or REGIONAL_MANAGER — only if an admin has ticked **Show the ACT!
sync section to this user** on their page in Settings → Users, which sets
`User.actSyncVisible`. A granted user gets the whole section, pressing **Sync
now** included, not just the reading of it. An ungated one gets no nav row and
a 404 on the URL, and the Sync now action refuses them too: all three gates ask
`canSeeActSync` (`src/lib/roles.ts`).

It went ADMIN-only → every signed-in user (2026-10-10) → per user, and the
middle step is why: opening it to managers is right for the company's own
managers, who work in ACT! daily and were the ones noticing an edit had not
arrived, and wrong for distributors — outside resellers with no ACT! licence
and no ACT! access at all. Their contacts still reach ACT! when they finalise a
quote, but a page about a CRM they cannot open means nothing to them. No role
tells those two kinds of manager apart, so an admin does. See `adminOnly` and
the ACT! sync entry in `src/lib/settings-nav.ts` for why this section is not
admin-only in the first place while the admin sections around it are.

The column defaults to **false**, and `z64_act_sync_visible` set it **true**
for every user that existed when it shipped. So nothing changed for anybody
already using the system, a new distributor is hidden without anybody
remembering to hide them, and a newly created real manager needs one tick
before they see the section. A change reaches a signed-in user within a few
minutes (the JWT revalidation window, `src/auth.ts`) or at their next sign-in.

So a run recorded as **Run by hand** no longer means a developer or the
director started it. If you are reconciling a surprise run against who was at a
keyboard, the record stores only the trigger, not the user — but the set of
people who could have pressed it is admins, developers, and whoever has that
tick.

**On the first load after this release it says "No run recorded yet", and that
is correct.** `act.sync.lastRun` arrived with this branch, so the full import of
2026-10-08 left a stored position and no run record: 17,529 contacts are in,
and the page has nothing to describe until the first run after the deploy. The
first nightly run fills it in, or **Sync now** does it immediately. The state
that would be wrong there is "Never run", which is what the page said before
this release was finished.

It is the first place to look because the worker records every run twice — once
at the start with `finishedAt: null`, once when it ends. A run killed mid-flight
therefore reads as "Started and never finished" instead of leaving last night's
success looking current. No log tail distinguishes those two; the page does.

The one case the page cannot show is a failure *before* the run takes the lock —
a stale or missing image, compose down, no `DATABASE_URL`, ACT! not answering.
Nothing is recorded, so the page goes on reporting the previous run, which is
why the alert email carries the log instead of pointing at the page. The two
rows behind it, if you need them from psql rather than the browser, are the
`Setting` keys `act.sync.lastRun` and `act.sync.cursor`.

### Everyday commands

```bash
systemctl list-timers 'pq-act-sync*'         # next run
systemctl start pq-act-sync.service          # sync now, from the box
journalctl -u pq-act-sync -n 20 --no-pager   # whether the unit itself ran at all
tail -40 /var/log/pq-act-sync.log            # "act:sync ok: image <sha>"
tail /var/log/pq-alert.log                   # "alert sent to <address>: <subject>"
/usr/local/bin/pq-backup-alert.sh --test pq-act-sync.service   # the sync-flavoured failure email
/usr/local/bin/pq-backup-alert.sh --test                       # bare --test is still the backup one
```

`systemctl start pq-act-sync.service` runs the script, which always passes
`--trigger=schedule`, so a run started by hand this way is still recorded and
shown as the nightly run. A run under `npm run act:sync` with no `--trigger`
records itself as run by hand, which is what it is.

What the exit status means, because the alert hangs off it:

| Exit | Means |
|---|---|
| 0 | the run finished — or another sync already held the lock, which is not this run's failure and deliberately raises no alert. The log line says plainly that nothing was read and nothing was written. |
| 1 | the run threw, or some contacts could not be stored. The cursor stops advancing at the first failure, so the next run reads them again. A 15-minute wait for the drain's lock that runs out is a throw too, before anything is read. |
| 2 | bad arguments, or `DATABASE_URL` missing or not a Postgres URL with a host and a database name. Nothing was read and nothing was written. |

What the run's drain did does not change its exit status: a drain that fails is
recorded and the read goes on, and a fault in sending that needs a person fails
the drain's own unit, which emails about it (§4d). Failing here as well would be
a second email about the same thing.

### A wedged advisory lock

The one state here that needs manual intervention. The symptom is every run —
nightly and button alike — reporting that a sync is already running when none
is.

The lock belongs to a Postgres *session*, so it is released by that session
ending. A run that is killed or crashes closes its socket on the way out and the
lock goes with it, which covers every ordinary failure. What does not close the
socket is the sync's container losing the network out from under a process that
is still alive: its network namespace torn down, or the systemd-networkd fault
in §6 ("systemd-networkd steals Docker's veth interfaces"), which un-enslaves
every `veth*` from `docker0` so packets stop at layer 2 while both ends still
believe the connection is open. That fault is one file on the host
(`/etc/systemd/network/05-docker-unmanaged.network`) away from coming back, so a
rebuild that skips §6 is the realistic way into this state. No FIN reaches
Postgres, so it keeps the session, and the lock, until its own TCP keepalives
give up on the socket. On the defaults that is about 2h11m
(`tcp_keepalives_idle` 7200s, then 9 probes 75s apart). Nothing in the
application can shorten it, so waiting it out is a real answer and usually the
right one — the next nightly run is at 03:00 either way.

A power cut or a hypervisor loss is **not** this case on this box. `postgres` is
a Compose service on the same VPS as the app and `DATABASE_URL` points at
`postgres:5432` (§1), so anything that takes the host down takes the cluster
with it: it comes back with no sessions at all, and no lock to wedge.

To find the holder. The predicate is `isSyncRunning`'s, from
`src/lib/act/sync.ts`, so what this prints can only be our own lock:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c "
SELECT a.pid, a.state, a.backend_start, a.query
FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
WHERE l.locktype = 'advisory'
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND ((l.classid::bigint << 32) | l.objid::bigint) = 8472001
  AND l.objsubid = 1
  AND l.granted;"
```

`objsubid = 1` is what separates our one-bigint key from another feature's
two-integer lock on (0, 8472001), and the `database` clause is there because
`pg_locks` is cluster-wide while advisory locks are per-database; both reasons
are written out at `isSyncRunning`. Keep them, because the next command
terminates one of these rows.

Expect no rows when nothing holds the lock and exactly one while a sync runs.
That row names itself twice over: its `query` is
`SELECT pg_try_advisory_lock($1) AS locked` — the statement that took the lock,
with the key bound as a parameter rather than written into the text — and its
`state` is `idle`, because that session's only job is to hold the lock while the
run talks to ACT! and to the database over other connections. A `backend_start`
older than any run you can account for is the dead session. End it — replace
`<pid>`, angle brackets and all, with the pid the query above printed:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c \
  "SELECT pg_terminate_backend(<pid>);"
```

The only other lever is `tcp_keepalives_idle` in `postgresql.conf`, which
applies to every session on that server rather than just this one.

### Proving the lock holds off the button

Done on production 2026-10-10, and holding the lock from a second session is
the only way that works. Starting the service and racing it with the button by
hand does not: a night's delta is seconds, so the run is over before anyone
reaches the browser. That was tried first and proved nothing.

Take the lock in an interactive psql, which is the reliable form:

```bash
cd /opt/pathquote
docker compose exec postgres psql -U pathquote -d pathquote
```

Then, in psql — press **Sync now** in the browser between the two statements:

```sql
SELECT pg_try_advisory_lock(8472001);   -- t: the lock is yours
SELECT pg_advisory_unlock(8472001);     -- t: released
\q
```

With the lock held, the button answered in amber with the lock's own sentence —
"A sync is already running. Wait for it to finish and try again." — under the
hint that promised it would ("A sync is already running, so this will not start
a second one — it will come back and tell you to wait. Reload the page instead
to see how the one that is going is getting on."). Not "Sync finished".

**The page itself looks entirely normal while the lock is held this way, and
that is the design, not a bug.** It reports the last run that finished: once a
record has a finish time the page describes that outcome and stops caring
whether the lock is held. Only the button refuses.

What the page reports and what psql shows are the same question asked twice.
This is `isSyncRunning`'s predicate (`src/lib/act/sync.ts`), so running it from
a second terminal while the lock is held is a check on the page as much as on
the lock:

```bash
cd /opt/pathquote
docker compose exec -T postgres psql -U pathquote -d pathquote \
  -c "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND ((classid::bigint<<32)|objid::bigint)=8472001 AND objsubid=1 AND granted) AS running;"
```

`t` while held, `f` after the unlock. That is the first time this predicate has
been confirmed against production's own Postgres — 16.15; until then it had
only been measured in a sandbox, which the comment at `isSyncRunning` records.

A lock taken by hand in an interactive session is released by
`pg_advisory_unlock` or by `\q`. Kill the terminal without either and it is
held until the connection dies, which is the wedged lock above, keepalives and
all.

**Do not background a one-liner to hold it for you.** This form self-releases
when `pg_sleep` ends, which is what makes it attractive:

```bash
cd /opt/pathquote
docker compose exec -T postgres psql -U pathquote -d pathquote \
  -c "SELECT pg_try_advisory_lock(8472001); SELECT pg_sleep(180);" &
```

The lock was taken and released on time, but the shell printed `[1]+ Stopped`
and a later `wait` warned `job 1[...] stopped`: a backgrounded
`docker compose exec` that touches the controlling terminal gets SIGTTIN and
the shell suspends it, `-T` or no `-T`. The psql inside the container keeps
running, so the test is still valid — and the operator cannot tell that from
the outside, which is the whole problem with it. Appending `</dev/null` before
the `&` should stop the suspension; that has not been tried on this box, so it
is a convenience to test, not the recipe to follow.

### The first import has to be run on the server

With no stored position in ACT!'s edit history, "the changes since last time"
means every contact in ACT! — about 17,500 of them, 88 pages — which is ten
minutes at best. The Settings page knows this and withholds the button in that
state, explaining that the first import belongs on the server. Do it there:

```bash
cd /opt/pathquote
TAG=$(git rev-parse HEAD) docker compose run --rm tools npm run act:sync -- --dry-run --limit 50
TAG=$(git rev-parse HEAD) docker compose run --rm tools npm run act:sync -- --full
```

The dry run reads ACT! and writes nothing, which is how to confirm credentials
and mapping before the first write. `TAG` is not optional: without it compose
resolves `:latest`, and nothing on this box ever refreshes that tag, so the run
silently uses whatever image was built months ago. The `--` is not optional
either — without it npm keeps the flags and the script starts with none, which
is a full write; it detects that and refuses.

### "Sync now", and what bounds it

The button on `/settings/act-sync` first sends the quotes queued for ACT!, if
sending is switched on, for at most 20 seconds (`SYNC_NOW_DRAIN_BUDGET_MS` in
`src/lib/act/sync-drain-lock.ts`; what is left goes with the 15-minute drain),
then runs the same delta, recorded as a run by hand. It does not wait for the
drain's lock: when another drain has it, the press starts nothing, records
nothing, and says in amber "Quotes are being sent to ACT! right now, so the sync
cannot start yet — try again in a few minutes." A night's changes take seconds. Two much larger numbers get quoted for
this and they are not the same number, so they are both written out here:

- **Nothing retries — ACT! is merely slow.** 88 pages of 200 contacts, each
  answering in 29 seconds, just inside the 30-second timeout, so every page
  succeeds on its first attempt: **about 43 minutes**. This is the ordinary bad
  day.
- **Everything retries.** One HTTP exchange is up to 3 attempts of that
  30-second timeout with 1s and 2s of backoff between them
  (`src/lib/act/client.ts`), so a page whose first two attempts time out and
  whose third answers costs 93 seconds. 88 of those is **about 2h16m**, and
  that is the ceiling — the slowest a run can be and still finish.

Do not quote the 43 minutes with the retry arithmetic beside it: 3 × 30s + 3s
is the 2h16m figure, not the 43-minute one.

Nothing in the application bounds either of them: `next.config.ts` declares no
`serverActions` limit, `maxDuration` means nothing to a long-running
`node server.js` behind a reverse proxy, and Node's own response timeout is off.

What bounds it is nginx's `proxy_read_timeout`, and on this server that is
**60 seconds**. Measured 2026-10-10: the directive is set nowhere in the live
configuration — 21,450 lines of it, with zero occurrences — so nginx's own
compiled-in default of 60s applies. Neither the proxy block in §3 nor the
WordOps template (§6) that actually serves the site sets a timeout, which is
what the code's comments had assumed; the number is now a fact about this box
rather than a value read out of nginx's documentation.

Re-check it after a WordOps update, which rewrites that generated template:

```bash
nginx -T 2>&1 | wc -l                           # 21450 on 2026-10-10
nginx -T 2>&1 | grep -c 'proxy_read_timeout'    # 0: the compiled-in 60s applies
```

60 seconds is comfortable for what the button actually does. A night's delta is
seconds, and its drain starts no new work after 20 of them. Both larger figures
above need a large backlog to read, and a backlog cannot build up now that the
timer runs every night — so the 504 below is a real case rather than the
expected one. It is not unreachable: a long ACT! outage followed by a click
still gets there, which is why the page handles it.

When it trips, nginx answers 504, the page reports that no answer came back —
and **the sync carries on**. Nothing cancels a server action because the client
went away, so it keeps the lock, finishes, and writes its record. Reload the
page: it says a sync is running now, and a later reload says what changed. A
second click meanwhile loses the lock race and says so.

### Installing or updating from the repository

```bash
scp -P 3498 scripts/ops/pq-act-sync.sh scripts/ops/pq-backup-alert.sh root@74.208.106.34:/usr/local/bin/
scp -P 3498 scripts/ops/pq-act-sync.service scripts/ops/pq-act-sync.timer scripts/ops/pq-backup-alert@.service root@74.208.106.34:/etc/systemd/system/
ssh -p 3498 root@74.208.106.34 'chmod 700 /usr/local/bin/pq-act-sync.sh /usr/local/bin/pq-backup-alert.sh && systemctl daemon-reload && systemctl enable --now pq-act-sync.timer'
```

That is the production host, the same address §4b's image-copy lines use, and
3498 is its sshd port rather than a typo (§6: WordOps moves sshd off 22).

`pq-backup-alert.sh` and `pq-backup-alert@.service` are in those lines because
both changed when the sync arrived: the script learned the sync wording and
which log to tail, and the unit now writes `/var/log/pq-alert.log` instead of
the backup log. `daemon-reload` is what picks up that unit change. Install only
the three new files and a sync failure emails the director about a backup, with
40 lines of the wrong log underneath it.

### Environment

`ACT_BASE`, `ACT_DB`, `ACT_USER` and `ACT_PASS` come from
`/opt/pathquote/.env`, the same file the app reads, so the timer and the button
use one set of credentials. `ACT_USER` is the Act! display name, not a login
id. The ACT! Web API is IP-allowlisted to this VPS: any other address, a laptop
included, gets `403` however correct the credentials, so this sync cannot be run
from anywhere else. Full reference: `docs/act-integration-reference.md`.

## 4d. ACT! write-back

A quote finalised in PathQuote reaches ACT! by itself, and its signature and
acceptance follow it there. Added 2026-10-13, and **off until somebody switches
it on** ("Before switching it on", below). Why each record is written the way
it is: `docs/superpowers/specs/2026-10-10-act-write-back.md`; the rules the
code keeps: the header of `src/lib/act/outbox-plan.ts`.

| When, in PathQuote | What ACT! gets |
|---|---|
| A quote is finalised | its contact, created as a **Prospect** when ACT! does not have them yet; **one opportunity for the deal**, named `<quote number> <currency>` (`Q-AU-2026-014 AUD`), at Proposal (AU, UK) or Engage (US); **one product line** on it, Item # the quote number, carrying the revision's amount **before tax** and named with it (`Q-AU-2026-014 — AUD 45,000.00 ex GST`), so regions with GST, VAT or no tax compare in the pipeline (decided 2026-10-13); and **a History** of type Quote for the revision, regarding `Quote Q-AU-2026-014 finalised in PathQuote` (`Q-AU-2026-014-R2` and so on for later revisions) |
| It is finalised again, changed | the same opportunity and the same line, updated in place, and a History for the new revision. A deal already closed in ACT! — Won, Lost, Inactive — is left as it is, except that a Won deal's line follows the latest figure the client has signed |
| The client signs | the contact goes from **Prospect to Customer**; any other status is left alone |
| It is accepted, the client's signature standing | the line brought to the signed figure, then the opportunity **Won**, at Sales Fulfillment (AU, UK) or Execute Fulfilment (US) — from Lost too, by decision ("PathQuote confirms", 2026-10-12) |

Everything is written as the service account `Marketing` (role Manager,
confirmed live 2026-10-12, `docs/act-integration-reference.md` section 2), with
the quote's author as record manager when they are mapped to an ACT! user, and
`Marketing` when they are not. Nothing is ever deleted in ACT!, and nothing
goes backwards: a void or an unfinalise afterwards undoes nothing there, and a
deal somebody marks Lost by hand after PathQuote won it stays Lost.

**Queued, then sent.** Each of those events queues one `ActOutbox` row for the
quote, in the same transaction as the event and whatever the switch says — or
takes over the quote's unfinished row. Three things send queued rows, and all
three send nothing while the switch is off:

| | When | Runs in | Log |
|---|---|---|---|
| The fast path | straight after the finalise, signature or acceptance, for that one quote | the `app` container | `docker compose logs app` |
| `pq-act-drain.timer` → `pq-act-drain.service` → `pq-act-drain.sh` | every 15 minutes, on the quarter hour, every row that is due | `docker compose run --rm -T tools npm run act:drain` in `/opt/pathquote`, `TAG` from `git rev-parse HEAD` | `/var/log/pq-act-drain.log` |
| The nightly sync, and **Sync now** (§4c) | at the start of every run that writes, before it reads ACT! | as §4c | `/var/log/pq-act-sync.log`, and the app's for Sync now |

One drain at a time: a Postgres advisory lock (`DRAIN_LOCK_KEY`, 8472002, in
`src/lib/act/drain.ts`); a drain that finds it taken sends nothing and says
`busy`. A step that fails backs its row off — 5 minutes, doubling, at most 6
hours (`backoffMs` in `src/lib/act/drain-rules.ts`) — and a row is never given
up on. A write ACT! **refuses** (a 4xx) is not tried again by itself: the quote
is held until a person acts ("When something is stuck", below).

### Before switching it on

In this order. Every command runs on the VPS, from `/opt/pathquote`, because
the ACT! API answers no other address (`docs/act-integration-reference.md`
section 11).

1. **Deploy** (§2b), so the running image has `act:drain` and
   `act:write-preflight`, and `/opt/pathquote/scripts/ops/` has the units this
   section installs. `git log -1 --oneline` on the VPS names the commit.

2. **Install the units** ("Installing or updating from the repository",
   below). The drain then runs every 15 minutes and, the switch being off, logs
   `switched off -- sending to ACT! is off (Setting act.write.enabled), so nothing was sent`
   with how many due rows wait, and exits 0. That is expected.

3. **Map the users.** The report first, then the write:

   ```bash
   cd /opt/pathquote
   TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:map-users
   TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:map-users -- --apply
   ```

   Read the report before `--apply`; what it maps, and what it will not, is in
   `docs/act-integration-reference.md` section 9.

   Users can also be linked **by hand**, in Settings → Users → *user* → ACT!
   (admins and developers only): pick the ACT! user and the Acc Mgr (Rep list
   item) from lists read live from ACT!, and Save. That is how distributors are
   linked — their ACT! users have no email and are Inactive, so the email join
   above cannot reach them — and a distributor must be on ACT!'s Rep list
   before they can be given an Acc Mgr. `act:map-users` never overwrites a
   stored link: it writes each column only where it is still empty. A hand link
   to an ACT! user with no email (or another person's email) shows in its
   report under DRIFT, saying it was made by hand; leave it. A hand link to the
   ACT! user with the person's own email is "already mapped", and `--apply`
   fills an empty Acc Mgr from that user's exact Rep item as for anyone mapped.
   The section only works on the VPS; anywhere else it says ACT! could not be
   reached and shows the stored values read-only.

4. **Run the preflight, and resolve every FAIL.**

   ```bash
   cd /opt/pathquote
   TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:write-preflight
   ```

   It writes nothing, to ACT! or to PathQuote. It asks ACT! with GETs only —
   it holds an `ActReader` (`src/lib/act/client.ts`), which has no method that
   sends anything else — and reads PathQuote in a transaction made `READ ONLY`
   before its first query. It takes no arguments. Each check prints PASS,
   WARN, FAIL or INFO with a line saying why, and for WARN and FAIL what to do.
   Exit 0 is nothing FAILed; 1 is a FAIL, or the run threw; 2 is a run that
   could not start (an argument, no `DATABASE_URL`, an `ACT_*` missing). The
   rules, with a test for each, are in `src/lib/act/write-preflight.ts`:

   | | Checks | FAIL | WARN |
   |---|---|---|---|
   | 1 | The service account: the one ACT! user whose `username` is `ACT_USER`, found as the drain finds it | none, or more than one; not Active; role Browse (read-only) or Standard ("My" permissions only) | role Administrator (more than it needs: reference section 2), or a role it does not know |
   | 2 | Active PathQuote users have `User.actUserId` | — | anybody unmapped: what is written for their quotes is managed by `Marketing`, and a contact created for them gets an Account Mgr only if their `User.actAccountMgr` is set |
   | 3 | Every `User.actAccountMgr` is an item of the Rep picklist, exactly | a value off the list: ACT! would refuse every contact created for that user's quotes | an active user with no ACT! user and no Account Mgr: their contacts are created with none |
   | 4 | The Countries picklist spells every country PathQuote's companies are in, by the drain's own match (`actCountryValue`) | — | a country with no item, or a company whose country PathQuote cannot read: contacts there are created with no country, which ACT! refuses if it enforces the field's `isAllowBlank: false` on an API create (not yet seen either way) |
   | 5 | `GET /api/opportunities` with the duplicate lookup's `name eq` filter: no rows for a name nobody has, then exactly the rows of one real name | rows for the made-up name (the filter is ignored), another name's rows, or the real opportunity missing | ACT! refuses the filter with a 4xx: the drain falls back to the contact's own opportunities |
   | 6 | Product lines come back with an `itemNumber` property, read off the first of 50 opportunities that has any | a line without it: the drain could never find its own line again, and could create a second — the deal's amount doubled | no opportunity with products: inconclusive |
   | 7 | `GET /api/contacts/{id}/history` with the History lookup's `regarding eq` filter: no rows for a made-up regarding, on a contact that has History | — | the filter ignored or refused: the drain reads the contact's whole History instead, and for a contact with 1,000 or more refuses it as a full page, so that quote's History — and the win and promotion after it — wait |
   | 8 | The switch, and every unfinished row, by quote number | — | switch off with rows queued (step 5), or switch on with a row held |
   | 9 | The 15-minute drain | — | — (INFO: the `tools` container cannot see systemd; it says what to run on the host) |
   | 10 | What is copied from ACT! by hand ("Things copied from ACT! by hand", below) | a stage gone, or in another process | a stage renamed or renumbered, the name length or a picklist id changed, or the metadata unreadable |

   A read that fails is a FAIL, "could not be checked": for checks 5 to 7 the
   request that failed is the very one the drain makes before a create. If the
   first request (check 1's) fails, nothing more is asked of ACT!. Run it again
   until nothing FAILs, and read every WARN.

5. **Take the test quotes out of the queue.** Check 8 lists every quote
   switching on would send, oldest first, each line ending in the quote's
   address (`/quotes/<id>`). Every quote finalised, signed or accepted since
   the write-back was deployed is there — test quotes and demos included. Open
   each one that must not reach ACT! at `https://q.pathfindercut.com/quotes/<id>`
   and press **Don't send this quote to ACT!** on its ACT! card: that is what
   the button is for. It needs an ADMIN or a DEVELOPER, and asks before it
   acts. Run the preflight again; check 8 should list real quotes only.

6. **Switch it on** ("The switch", below).

7. **Finalise one real quote that is safe to send, and check ACT! by hand.**
   The fast path sends it as the finalise returns, so it is there within a
   minute, or within 15 if another drain was busy. Its ACT! card in PathQuote
   says **In ACT!**, with Contact, Opportunity, Amount and History. In ACT!:
   - the contact: the one ACT! already had, or a new **Prospect** with the
     name, email, phone (as sent), title, company text, country and — when the
     author has one — Account Mgr;
   - **one** opportunity named `<quote number> <currency>`, at Proposal (AU,
     UK) or Engage (US), its record manager the author (or `Marketing`);
   - on it **one** product line, Item # the quote number, its amount the
     quote's total **before tax** (the PDF's total less its GST, VAT or Sales
     Tax), its name saying so: `<quote number> — <currency> <amount> ex GST`;
   - **one** History, type Quote, regarding `Quote <quote number> finalised in PathQuote`,
     its details the same amount before tax and, on the next line, the total
     with tax for reference.

8. **Finalise it again, unchanged** (unfinalise, then finalise). Nothing new
   may appear in ACT!: still one opportunity, one line, one History.

9. **Watch** Settings → ACT! sync → **Quotes for ACT!** through the first day,
   and the first nightly run at 03:00, whose record on the same page now says
   what its drain sent before the read.

**The acceptance checks** — what the plan
(`docs/superpowers/plans/2026-10-12-act-write-back-quotes.md`, "Verification
that cannot be done from a laptop") leaves for the live box. Steps 7 and 8 are
its first two. Then, as real quotes allow:

- [ ] The sync after step 7 — Sync now, or 03:00 — does **not** count the
      contact it touched as updated. This is echo suppression, and nothing but
      the live box can prove it.
- [ ] A quote whose contact existed only in PathQuote: ACT! has them as a
      Prospect, with the phone as sent, and the quote's card names the contact
      as in ACT!.
- [ ] A quote at a company whose country check 4 found missing from the
      Countries list: ACT! takes the contact with no country. If it refuses,
      the quote is held with ACT!'s own words: add the country to the list,
      then **Try again now**.
- [ ] A FINAL quote with no contact: its card says **Held back from ACT!**, and
      why, rather than failing in silence.
- [ ] A quote finalised while sending is switched off: it finalises, its card
      says it is waiting, and the first 15-minute pass after switching on sends
      it. (The plan's version — stop ACT!, or point `ACT_BASE` at a closed
      port — proves the same for an outage, at the cost of restarting
      production's app; the switch is the safe form.)
- [ ] A client signs a quote whose contact is a Prospect: the contact becomes a
      Customer. A contact of any other status is left as it was.
- [ ] That quote is accepted: the opportunity goes to Won, at the 100% stage. A
      second accept writes nothing (`acceptQuote` returns early for a quote
      already accepted).
- [ ] A quote whose opportunity was marked Lost in ACT! is accepted: it goes to
      Won. Mark it Lost again by hand: a later revision leaves it Lost.

### The switch

The `Setting` row `act.write.enabled`: off unless it holds JSON `true`. There is
no screen for it. **On:**

```bash
cd /opt/pathquote
docker compose exec -T postgres psql -U pathquote -d pathquote -c "INSERT INTO \"Setting\" (\"key\", \"value\") VALUES ('act.write.enabled', 'true') ON CONFLICT (\"key\") DO UPDATE SET \"value\" = 'true';"
```

**Off, at once:**

```bash
cd /opt/pathquote
docker compose exec -T postgres psql -U pathquote -d pathquote -c "INSERT INTO \"Setting\" (\"key\", \"value\") VALUES ('act.write.enabled', 'false') ON CONFLICT (\"key\") DO UPDATE SET \"value\" = 'false';"
```

Where it stands:

```bash
cd /opt/pathquote
docker compose exec -T postgres psql -U pathquote -d pathquote -c "SELECT value FROM \"Setting\" WHERE key = 'act.write.enabled';"
```

No restart either way. Every drain reads the switch at the start of a pass and
again before each call it makes to ACT!, so turning it off stops a pass
**between calls**: a call already on its way finishes, and its result is
stored. The queue is left exactly as it is. Finalising, signing and accepting go
on queueing while it is off, and switching it back on sends what queued — at
the next 15-minute pass, or a quote's own next event.

### Installing or updating from the repository

The files arrive in `/opt/pathquote` with the deploy's `git pull`, so they are
installed from there:

```bash
cd /opt/pathquote
install -m 700 scripts/ops/pq-act-drain.sh scripts/ops/pq-backup-alert.sh /usr/local/bin/
install -m 644 scripts/ops/pq-act-drain.service scripts/ops/pq-act-drain.timer scripts/ops/pq-backup-alert@.service /etc/systemd/system/
install -d /var/lib/pathquote/alert-stamps
install -m 644 scripts/ops/pathquote.logrotate /etc/logrotate.d/pathquote
systemctl daemon-reload
systemctl enable --now pq-act-drain.timer
```

`pq-backup-alert.sh` and `pq-backup-alert@.service` are in it because both
changed with the drain: the script learned the drain's wording, its log and the
once-a-day stamp ("Alerts", below). Install only the drain's own three files
and a drain failure emails as a unit the script knows nothing about, with no
log, and every 15 minutes rather than once a day. The stamp
directory is also made by the script on its first drain alert; made here, it is
never the question.

```bash
systemctl list-timers 'pq-act-*'                 # the drain every quarter hour, the sync at 03:00
systemctl start pq-act-drain.service             # one pass now, as the timer runs it
journalctl -u pq-act-drain -n 20 --no-pager      # whether the unit itself ran at all
tail -20 /var/log/pq-act-drain.log               # "act:drain ok: image <sha>"
```

One quote's rows, now, by the quote's id — the end of its address, not its
number:

```bash
cd /opt/pathquote
TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:drain -- --document <quote id>
```

The `--` is not optional: without it npm keeps the flag and the run would
drain every due row, which the script detects and refuses. What `act:drain`'s
exit status means, because the alert hangs off it (`scripts/act-drain.ts`):

| Exit | Means |
|---|---|
| 0 | every normal outcome: quotes sent, held back or backing off; nothing due; another drain busy; sending switched off; the 5-minute budget spent; or ACT! busy or away |
| 1 | a fault that needs a person — the service account not found, the login refused, a 403 to the login or the users lookup, IIS turning the VPS away — or the pass threw (the database) |
| 2 | it could not start: bad arguments, no identifiable `DATABASE_URL`, or an `ACT_*` variable missing |

### Log rotation

Every PathQuote log on this box — `/var/log/pq-backup.log`, `pq-act-sync.log`,
`pq-act-drain.log`, `pq-act-weekly-report.log` and `pq-alert.log` — is rotated
by `scripts/ops/pathquote.logrotate`, installed above as
`/etc/logrotate.d/pathquote`: monthly, or sooner once a log passes 10M
(logrotate runs daily, from Ubuntu's `logrotate.timer`, and checks the size each
time), twelve kept, compressed one rotation late. The drain alone writes its log
96 times a day, which is why this came with it. To see what it would do, and do
nothing:

```bash
logrotate -d /etc/logrotate.d/pathquote
```

"log does not need rotating" for each file is the ordinary answer; a log
already over 10M is one it says it would rotate.

**No `copytruncate`, and it needs none.** Every unit writes its log through
`StandardOutput=append:`, which systemd opens by its path — `O_APPEND`, created
if missing — each time it starts the unit, for that run's processes alone; and
every unit is `Type=oneshot`, so nothing holds the file between runs. Once
logrotate has renamed a log, the next run writes a fresh file at the old name.
A run going at that moment — the drain, every 15 minutes, is the likeliest —
ends in the renamed file, `pq-act-drain.log.1`, which `delaycompress` leaves
uncompressed until the rotation after. The one cost is the failure email, which
tails 40 lines by the log's name: for a run that started before a rotation and
failed after it, the email carries the new file's few lines, and the run is in
the `.1` file. Worked out from the units and checked with `logrotate -d` on a
scratch Ubuntu 22.04, not yet on the VPS; Ubuntu's stock `/etc/logrotate.conf`
carries `su root adm`, which is what lets logrotate work in a group-writable
`/var/log` without complaint.

### Reading the queue

**Settings → ACT! sync → Quotes for ACT!** (`/settings/act-sync`) first. It
shows the queue as it stands — not what the last run did — from the rows
themselves: whether sending is on, how many quotes are waiting, and every quote
held back, by number, as a link, with the reason PathQuote gives for holding it
(the 20 queued longest; the rest are counted). Amber means somebody has to act.
Who sees it is §4c's rule: every ADMIN and DEVELOPER, and anyone with **Show the
ACT! sync section to this user** ticked, who is counted only the quotes they can
open.

**The quote's own page** has an **ACT!** card, for the same readers. It says
where that quote stands — waiting to go to ACT!, **Held back from ACT!** (and
why), **In ACT!** (with the contact, the opportunity, the amount and the History
there), or not sent — and, to an ADMIN or DEVELOPER only, the buttons under
"When something is stuck". A FINAL quote never queued (finalised before the
write-back) says **Not queued for ACT!**, to an administrator only.

**SQL, when the pages are not enough.** Every unfinished row, oldest first:

```bash
cd /opt/pathquote
docker compose exec -T postgres psql -U pathquote -d pathquote -c "SELECT o.id, d.number, d.id AS \"documentId\", o.\"createdAt\", o.attempts, o.\"nextAttemptAt\", o.\"blockedBy\", o.\"blockedReason\", o.\"lastError\" FROM \"ActOutbox\" o JOIN \"Document\" d ON d.id = o.\"documentId\" WHERE o.\"completedAt\" IS NULL ORDER BY o.\"createdAt\";"
```

The times are UTC. A row with no `blockedReason` is waiting: due once
`nextAttemptAt` has passed, and backing off until then after `attempts`
failures. A row with one is held, and `blockedBy` says by what: empty for
PathQuote's own planner (a quote with no contact, a region with no ACT!
process), `contact`, `drain` (duplicates in ACT!), `act` (ACT! refused) or
`revision` — the next section takes each in turn. Finished rows stay in the
table, one per write.

### When something is stuck

The quote's ACT! card first: its reason is written for whoever reads it, and
its buttons — an ADMIN's or a DEVELOPER's — cover the common cases. **Try again
now** and the two contact buttons take effect at once; with sending on,
PathQuote then sends that quote straight away, or within 15 minutes if another
send is under way.

| Held because (`blockedBy`) | Do | What happens next |
|---|---|---|
| ACT! refused the write — the reason quotes ACT!'s own words (`act`) | Put right in ACT! what it objected to — a country missing from the list, an Account Mgr off the Rep picklist, a permission — then **Try again now** | The same step goes again. Pressed before ACT! is put right, it is refused and held again |
| ACT! has more than one opportunity, or product line, for this quote (`drain`) | Remove the extra records in ACT! by hand: PathQuote never deletes in ACT! | The 15-minute passes look again by themselves, up to 10 such quotes a pass, and the quote goes on once one is left; **Try again now** looks now |
| PathQuote cannot read the finalised copy (`revision`) | The developer fixes it; **Try again now** only after that | The copy is read again |
| The quote has no contact, its contact has no name, and the like (empty) | Fix it in PathQuote, as the reason says | The next pass sees the fix and sends it; there is no button, and none is needed |
| PathQuote asked ACT! to create the contact and never heard whether it did (`contact`) | Look in ACT! for the person, by name and email, created around when the quote was sent. Found: **ACT! has this person**, with their ACT! contact id. Not there: **ACT! has nobody** | Found: PathQuote reads that id back from ACT! first, links nothing unless ACT! has the contact and their name or email matches, then links them and sends every quote held on them. Not there: the next send creates them |
| It should not go to ACT! at all — a test quote | **Don't send this quote to ACT!** | Out of the queue; what is already in ACT! stays. The quote's next finalise, signature or acceptance queues it again |

A held contact is never fixed by deleting the contact in PathQuote and adding
them again: the new contact carries no record that a create may have gone
through, and the next send creates the same person in ACT! a second time.

**The developer's SQL**, for a held contact when the page cannot be used, or
when **ACT! has this person** refuses because another PathQuote contact already
carries that ACT! id. Expect that second case once a sync has run since the
create: ACT! did make the person — a Prospect, edited after the sync's cursor —
and the sync imported them as a second PathQuote contact. From
`/opt/pathquote`, replacing `<contact id>`, `<duplicate id>` and `<act id>`,
angle brackets and all.

Which contacts are held, their create's outcome unknown:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c "select id, \"firstName\", \"lastName\", email, \"actCreateInFlightAt\" from \"Contact\" where \"actCreateInFlightAt\" is not null and \"actContactId\" is null;"
```

`actCreateInFlightAt` is when the create was about to leave, in UTC. Whether
ACT! answered with an id that PathQuote then failed to store — the drain logs
it, with the outbox row's `id`, the `contactId`, and the ACT! id as
`actContactId`:

```bash
docker compose logs app 2>&1 | grep -A 8 'whose id PathQuote could not store'
grep -A 8 'whose id PathQuote could not store' /var/log/pq-act-drain.log /var/log/pq-act-sync.log
```

The fast path and Sync now log in the app; the 15-minute drain and the nightly
sync in their own logs. No such line for the contact — no answer, a 5xx, a 408;
the log says `act: ACT! may have created this contact` for those — means
PathQuote never had an id: look for the person in ACT! by name and email.

If ACT! holds the person, give PathQuote that id:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c "UPDATE \"Contact\" SET \"actContactId\" = '<act id>', \"actSyncState\" = 'SYNCED', \"actCreateInFlightAt\" = NULL WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL;"
```

If that fails on `Contact_actContactId_key`, the sync has imported the person
as a second contact. Find it:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c "select id, \"firstName\", \"lastName\", email, \"companyId\" from \"Contact\" where \"actContactId\" = '<act id>';"
```

and merge it into the held contact — its quotes and signing requests moved
over, the duplicate deleted (its `ActSnapshot` goes with it), the id set — in
one transaction, every statement but the last also checking that the held
contact is still held:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -v ON_ERROR_STOP=1 -c "BEGIN; UPDATE \"Document\" SET \"contactId\" = '<contact id>' WHERE \"contactId\" = '<duplicate id>' AND EXISTS (SELECT 1 FROM \"Contact\" WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL AND \"actContactId\" IS NULL); UPDATE \"SigningRequest\" SET \"contactId\" = '<contact id>' WHERE \"contactId\" = '<duplicate id>' AND EXISTS (SELECT 1 FROM \"Contact\" WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL AND \"actContactId\" IS NULL); DELETE FROM \"Contact\" WHERE id = '<duplicate id>' AND \"actContactId\" = '<act id>' AND EXISTS (SELECT 1 FROM \"Contact\" WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL AND \"actContactId\" IS NULL); UPDATE \"Contact\" SET \"actContactId\" = '<act id>', \"actSyncState\" = 'SYNCED', \"actCreateInFlightAt\" = NULL WHERE id = '<contact id>' AND \"actCreateInFlightAt\" IS NOT NULL; COMMIT;"
```

psql prints each statement's count. `DELETE 1` and, after it, `UPDATE 1` is the
merge done. `DELETE 0` and `UPDATE 0` is a contact no longer held, or a wrong
contact id, and nothing changed. An error — `Contact_actContactId_key` again,
for a wrong duplicate id — rolls the whole of it back.

If ACT! holds nobody, release the hold, and the next pass creates them:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c "UPDATE \"Contact\" SET \"actCreateInFlightAt\" = NULL WHERE id = '<contact id>' AND \"actContactId\" IS NULL;"
```

After any of these, nothing else is needed: the next full pass — the 15-minute
drain, or the nightly sync's — re-plans every held row, finds the contact
settled, and sends every quote on it. (The buttons also make those quotes due
at once; the SQL leaves that to the pass.)

To take a quote out of the queue when its page cannot be used — the same write
as **Don't send this quote to ACT!** — by the row's `id` from the queue query
above, replacing `<id>`:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c "UPDATE \"ActOutbox\" SET \"completedAt\" = now() AT TIME ZONE 'UTC', \"blockedBy\" = 'admin', \"blockedReason\" = NULL, \"generation\" = \"generation\" + 1, \"updatedAt\" = now() AT TIME ZONE 'UTC' WHERE id = '<id>' AND \"completedAt\" IS NULL;"
```

`blockedBy = 'admin'` is what makes the quote's card say it was not sent rather
than **In ACT!**, and `now() AT TIME ZONE 'UTC'` rather than `now()` is because
these columns hold UTC without a zone.

**Every pass says `busy`, and nothing is sent.** The drain's lock is held by a
session that is gone — §4c's "A wedged advisory lock", for the same reasons,
with the drain's key. The drain exits 0 on `busy` and does not email; the
nightly sync waits 15 minutes for the lock, fails, and does. The holder:

```bash
docker compose exec -T postgres psql -U pathquote -d pathquote -c "
SELECT a.pid, a.state, a.backend_start, a.query
FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
WHERE l.locktype = 'advisory'
  AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND ((l.classid::bigint << 32) | l.objid::bigint) = 8472002
  AND l.objsubid = 1
  AND l.granted;"
```

A drain that is working holds it briefly — a fast path for seconds, a 15-minute
pass for 10 minutes at the very worst — and the nightly sync for its whole run.
A `backend_start` older than any of those is the dead session: end it with
§4c's `pg_terminate_backend`, its pid in place of `<pid>`.

### Alerts

A pass that exits 1 fails `pq-act-drain.service`, which starts
`pq-backup-alert@pq-act-drain.service.service`, as for the backups and the sync
(§4): an email to marketing@pathfindercut.com, subject
`[PathQuote] ACT! quote drain FAILED on` the hostname, saying that queued quotes
are not reaching ACT! — nothing is lost, they go once it is fixed — with the
last 40 lines of `/var/log/pq-act-drain.log`.

**Once a day at most.** The unit runs every 15 minutes and fails at every tick
until somebody mends what is wrong, so the alert stamps
`/var/lib/pathquote/alert-stamps/pq-act-drain.service.last-sent` when it sends,
and while the stamp is under 24 hours old sends nothing, logging
`alert for pq-act-drain.service suppressed` to `/var/log/pq-alert.log` instead.
A pass that gets writes into ACT! again removes the stamp (`pq-act-drain.sh`,
on the line `act:drain` prints for it), so a fault that comes back after a
recovery emails at once. Every other unit's alert is as before: one email per
failure.

```bash
/usr/local/bin/pq-backup-alert.sh --test pq-act-drain.service   # the drain's email; a test is never held back and never stamps
ls -l /var/lib/pathquote/alert-stamps/                           # a stamp is a drain alert sent within the last day
tail /var/log/pq-alert.log
```

**What the drain does not email about.** ACT! busy or away — no answer, a 5xx,
"not now" — is exit 0: a weekend with the office's ACT! server off is not
PathQuote's fault, and the rows back off. That includes the VPS cut off by a
**firewall or the NAT rule**, which looks the same as ACT! being down: no answer
at all. What catches that is the **nightly sync's** alert (§4c): its run asks
ACT! before it reads, gets no answer either, and fails its unit. IIS's own 403
to an address off its allow-list *is* an answer, and the drain emails about it.

### Things copied from ACT! by hand

Four things the write-back depends on are transcribed into the code; nothing
reads them from ACT! at runtime, and an ACT! administrator can make any of them
wrong without anyone here noticing. **Check 10 of the preflight re-reads all
four** — `GET /api/opportunities/stages` and `GET /api/metadata/fields` — and
when one differs prints what ACT! has now. Run it after any change to ACT!'s
sales processes or fields, and after an ACT! upgrade:

```bash
cd /opt/pathquote
TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:write-preflight
```

| What | Written in | Goes wrong when | Its first sign otherwise |
|---|---|---|---|
| The four stage ids — Proposal and Sales Fulfillment (Pathfinder Sales Cycle), Engage and Execute Fulfilment (Pathfinder US Sales Process) — with their numbers | the table in `src/lib/act/opportunity-stages.ts` | an administrator deletes, re-creates, renames or reorders a stage or a process | an opportunity write refused deep in the drain, or stages ordered by the old numbers in silence |
| The Rep picklist's id, behind Account Mgr | `REP_PICKLIST_ID` in `src/lib/act/client.ts` | the list is re-created | `npm run act:map-users` and check 3 read a list that is gone: a 404 |
| The Countries picklist's id, behind a contact's country | `COUNTRIES_PICKLIST_ID` in `src/lib/act/client.ts` | the list is re-created | every contact created with no country; the drain logs `act: the Countries picklist has <n> items` on each pass that creates a contact |
| The opportunity name's limit, 32 characters | `OPPORTUNITY_NAME_MAX` in `src/lib/act/write-payloads.ts` | the field is redefined | none soon: today's names are under 20 characters |

The picklists' items are never copied — the drain and `act:map-users` read them
every time; only the lists' ids are pinned. Change the file to match ACT!, never
ACT! to match the file, and deploy before the next send.

## 4e. Monday ACT! activity report

Every Monday each sales manager gets one email with last week's activity from
ACT!, in the format marketing used to send by hand: Call Completed, E-mail Sent,
Meeting Held (ACT! history types 1, 16, 6, counted by Record Manager) and
Prospects generated (contacts they manage, created in the week, ID/Status
Prospect). Added 2026-10-12.

| | |
|---|---|
| Unit | `pq-act-weekly-report.timer` → `.service` → `pq-act-weekly-report.sh` |
| When | Mondays 08:00 Australia/Melbourne; `Persistent=true` |
| Period | the last finished Monday–Sunday week in Melbourne, whatever day it runs |
| Runs | `docker compose run --rm -T tools npm run act:weekly-report`, `TAG` from `git rev-parse HEAD` |
| Recipients | `src/lib/act/weekly-report-recipients.ts` — To is the manager's ACT! email, CC per manager; a change is a commit and a deploy |
| Sends | through the app's SMTP (Resend), From `Pathfinder Marketing <EMAIL_FROM address>`, Reply-To marketing@ |
| Log | `/var/log/pq-act-weekly-report.log` |
| Failure | `pq-backup-alert@pq-act-weekly-report.service` emails marketing@ with the log |

Read-only against ACT!, no database. Logic in `src/lib/act/weekly-report.ts`.

### Before trusting it, and any time a number looks wrong

```bash
cd /opt/pathquote
TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:weekly-report -- --dry-run
TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:weekly-report -- --dry-run --from 2026-10-04 --to 2026-10-11
TAG=$(git rev-parse HEAD) docker compose run --rm -T tools npm run act:weekly-report -- --send-to you@pathfindercut.com
```

`--dry-run` sends nothing and prints, per manager, the four numbers, every
history type they have in the window (so a count can be checked against ACT!'s
History tab) and the email exactly as it would go: From, To, Cc, Reply-To,
Subject and the text body. Nothing is stored anywhere; the sent emails are the
only record. `--send-to` sends every report to one address with no CC.
`--from`/`--to` are inclusive Melbourne days. The `--` is required; without it
the script refuses rather than sending for real.

`GET /api/History` filtered on `startTime` had not been exercised against the
live box when this was written. If the dry run fails with a 400 on that path,
that is where to look (`ActClient.historiesBetween`).

Private history records are invisible to the integration account, so they are
not counted.

### Installing or updating

```bash
scp -P 3498 scripts/ops/pq-act-weekly-report.sh scripts/ops/pq-backup-alert.sh root@74.208.106.34:/usr/local/bin/
scp -P 3498 scripts/ops/pq-act-weekly-report.service scripts/ops/pq-act-weekly-report.timer root@74.208.106.34:/etc/systemd/system/
ssh -p 3498 root@74.208.106.34 'chmod 700 /usr/local/bin/pq-act-weekly-report.sh /usr/local/bin/pq-backup-alert.sh && systemctl daemon-reload && systemctl enable --now pq-act-weekly-report.timer'
```

`pq-backup-alert.sh` is in the list because it learned this unit's wording.

```bash
systemctl list-timers 'pq-act-weekly*'               # next Monday
systemctl start pq-act-weekly-report.service         # send last week's reports now
tail -40 /var/log/pq-act-weekly-report.log
```

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
