# Audit port triage: `audit/modernization` vs `origin/main` (2026-10-15)

- Audit branch: `audit/modernization` @ d8d90ae. 126 commits, merge-base 60ff2f8.
- Main: `origin/main` @ 1ff801f. 235 commits since the merge-base; migrations go up to `z67_user_commission_tiers`.
- Source of findings: `git show audit/modernization:AUDIT_WORKLOG.md`, Findings table.

## Method

This was a read-only triage; no checkout or merge was done.

- **Patch equivalence.** `git cherry origin/main audit/modernization` reports **no** patch-equivalent commits. Every status below therefore comes from reading the code on `origin/main` (`git show origin/main:<path>`, `git grep -n … origin/main`). Commit messages were not trusted.
- **Line numbers.** "main path:line" always means the file as it is on `origin/main` @ 1ff801f.
- **Apply check.** Each audit commit's diff was applied on its own to a temporary index of `origin/main`, with `git apply --cached --check`. The result is shown as CLEAN or FAIL.
  - FAIL often only means that an earlier audit commit is missing, so it is a lower bound on difficulty.
  - The real conflict size was judged by comparing hunk context with `git diff 60ff2f8 origin/main -- <file>`.
- **Statuses:**
  - **PRESENT**: main has an equivalent fix.
  - **PARTIAL**: main has part of the fix.
  - **MISSING**: the bug is still on main; the evidence column cites the still-buggy code.
  - **OBSOLETE**: main changed the code so the fix no longer applies.
  - **OPEN**: an owner decision that has still not been taken.
- **Value** is the audit's own grade (P0 to P3).
- **Port difficulty:**
  - easy: a clean or trivial cherry-pick.
  - small conflicts: a cherry-pick plus a hand-merge of a few hunks.
  - re-implement: the code moved, so the fix has to be redone on main's version.
  - large: big and spread over many files.

## Summary counts

**Findings** (42 rows of the worklog's Findings table; grouped IDs such as `UI-05/06/23` count as one row):

| Status | Count | Rows |
|---|---|---|
| PRESENT | 4 | OPS-02, ARCH-01, SEC-A3, UI-02 |
| PARTIAL | 5 | OPS-01, ARCH-02/03, ARCH-04/SEC-M5, SEC-D5, UI-04 |
| MISSING | 32 | everything else except ARCH-05 |
| OPEN decision | 1 | ARCH-05 (dead send-dialog code still on main, still uncalled) |
| OBSOLETE | 0 | Only sub-parts are obsolete: the Ex Works tax drift in ARCH-02/03, the readiness link in UI-14, and a844543. |

**Commits** (126 in all):

| Group | Count | Notes |
|---|---|---|
| `docs(comments): trim …` | 24 | Comment-only, verified by AST compare (see below). Do not port. |
| Merge commits | 13 | Do not port. |
| `chore(audit)` worklog-only | 6 | 39dca97, d837743, 777ced1, dd411d7, a5ecca1, ef719ba. Reference only. |
| Code, ops and docs | 83 | Triaged below. d8d90ae is counted here because it also adds `ops/prod-report-pricing-flags.sql`. |

Status of the 83 triaged commits:

| Status | Count | Commits |
|---|---|---|
| PRESENT | 6 | 697c345, 3522673, f95e5bb, 2250f5f, bacff13, c2483d9 |
| PARTIAL | 9 | eaa4dac, f8b61e6, 675b179, ae92f9d, 4ed7507, 911c4f1, efb6035, f918a11, 5a9a3c1 |
| OBSOLETE | 1 | a844543 |
| MISSING | 67 | Includes 7 docs-only commits. |

**Comment-only check.** Each of the 24 `docs(comments)` commits was checked file by file. The before and after versions were parsed with the TypeScript compiler and printed with `removeComments`. For css, prisma and sql files, comments were stripped and whitespace normalised. **All 24 are AST-identical with and without comments, so no code change hides in them.** They only trim comments (ARCH-13). Main has since grown to 35.5% comment lines, so these diffs no longer apply anyway. Do not port them.

**Schema.**

- The audit's `z51_snapshot_pricing_flags` and `z52_user_session_version` collide with main's `z51_drop_option_attribute_schema` and `z52_option_consumables`.
- Neither audit change exists on main:
  - `DocumentItem` and `DocumentLine` have no `isCredit`/`noCommission` columns (main `prisma/schema.prisma` has the flags only on `Product`:487/499 and `Option`:541).
  - `User` has no `sessionVersion`.
- If ported, renumber them after z67, for example `z68_snapshot_pricing_flags` and `z69_user_session_version`. Update every reference: schema comments, the migration header and `ops/prod-report-pricing-flags.sql`.

## Backup verdict (OPS-01, OPS-03, OPS-04)

The owner is right that backups exist and run. Main installed them on the VPS on 2026-09-29 (412f235, 588daf4, 69737a6).

Scripts on main: `scripts/ops/pq-backup.sh`, `pq-backup-{db,files}.{service,timer}`, `pq-backup-alert.sh` and `pq-backup-alert@.service`, `pathquote.logrotate`. Runbook §4.

| Capability | main (`scripts/ops/`, active in prod) | audit (`ops/backup`, `ops/deploy`, never activated) |
|---|---|---|
| DB dump schedule | daily 04:00 Melbourne (`pq-backup-db.timer`) | nightly 03:15 (`pq-backup.timer`) |
| Uploads (signed PDFs, signature PNGs) | **weekly** (Sat 04:30, `pq-backup-files.timer`), so the RPO for signed documents is up to 7 days | nightly, in the same bundle as the DB |
| Format | plain `pg_dump` SQL, gzipped (`pq-backup.sh:50-51`) and `tar czf` of the volume | `pg_dump -Fc` in an exported snapshot, plus a per-table row-count fingerprint, a sha256 of every upload, `manifest.json` and `SHA256SUMS` |
| Integrity check at backup time | `gunzip -t` and at least 10 `CREATE TABLE` (`pq-backup.sh:52-58`) | checksums plus a fingerprint; the bundle is verified before upload |
| Off-site copy | yes: `rclone sync` to `gdrive:PathQuote/backups`, with `--max-delete 6` and no trash (`pq-backup.sh:72-74`) | yes: rclone to the configured remote, with retention logic and a test (`test-retention.sh`, run in CI) |
| **Encryption** | **none.** The Drive copy, on the marketing Gmail account, holds plaintext client PII, password hashes, signatures and signed PDFs. | **age**: the host holds only the public recipient; the decrypting identity is kept offline |
| Failure alert | yes: `OnFailure=pq-backup-alert@%n` email | yes: healthchecks.io ping on start and fail |
| **Staleness / dead-man check** | **none.** If the timer is disabled, the box is down or the unit never starts, nothing alerts. | `pq-backup-check.sh` plus its own timer: fails if the newest full bundle, locally *and* on the remote, is older than `MAX_AGE_HOURS` |
| **Restore script** | **none.** Runbook §4 "Restore procedure" (main `docs/runbook.md:397-430`) pipes `gunzip -c … \| psql` **without `ON_ERROR_STOP`** (:408, :419), restores **into the live DB**, offering a `DROP DATABASE pathquote` variant (:413-420), and starts the app **before** `migrate deploy` (:428-429). OPS-03 is still present. | `pq-restore.sh`: restores into a *new* compose project or DB, refuses a non-empty target, needs `--force-into` plus a bundle-bound confirm token to overwrite, and verifies the fingerprint and checksums. Optionally boots the app on another port. |
| Restore drill | none recorded in the repo | done: 48 MB DB plus 500 MB files, backup 36 s, restore to a healthy app 23 s (worklog) |
| **Pre-migration dump in the deploy** | **none.** `.github/workflows/deploy.yml:185-186` runs `up -d postgres` then `prisma migrate deploy` with no dump. The runbook only suggests a manual `systemctl start pq-backup-db.service` "before a risky migration". OPS-04 is still present. | `ops/deploy/deploy.sh` runs `pq-backup.sh --db-only --no-upload --label premigrate` before migrating, and **fails closed** |
| Log rotation | `/var/log/pq-*.log` via logrotate. Container json logs are not rotated (see OPS-07). | compose json-file 5 × 10 MB |

**Verdict: PARTIAL.** Main has working scheduled, off-site, alerting backups, which was the core of the P0. It lacks five things:

1. Encryption of the off-site copy.
2. A staleness (dead-man) check.
3. A safe, verifying restore script, plus a restore runbook that cannot half-fail. OPS-03 is MISSING.
4. A pre-migration dump in the deploy. OPS-04 is MISSING.
5. Nightly uploads, because signed PDFs are only copied weekly. This is an RPO decision for the owner.

**Recommendation: extend main's scripts; do not drop in the audit's `ops/backup`.** The audit's system is better engineered, but adopting it means replacing a working production pipeline:

- disabling main's units;
- an age keypair, kept offline;
- `/etc/pathquote/backup.env`;
- healthchecks.io;
- a new artifact format.

Its `deploy.sh` also hard-depends on `ops/backup/pq-backup.sh` and fails every deploy until that is installed. The minimal port onto main, in order:

1. A pre-migrate `pq-backup.sh db` call in the deploy script. Main's script holds a 1 h flock, so pass a shorter wait or a `--no-upload` mode.
2. Rewrite runbook §4 "Restore procedure":
   - add `-v ON_ERROR_STOP=1`;
   - restore into a scratch DB first;
   - run `migrate deploy` before `up -d app`.

   Alternatively, adapt `pq-restore.sh` to main's `.sql.gz` and `.tar.gz` files.
3. A staleness check: `pq-backup-check.sh` logic against `/opt/backups` and `rclone lsf` of the remote, on its own timer, alerting through main's `pq-backup-alert@`.
4. age encryption of both artifacts before `rclone sync`. This needs the owner to create and store an offline key.
5. Optional: uploads nightly, or the `tar` replaced by an incremental `rclone copy` of the volume.

## Findings table

Path:line references are on origin/main unless marked "audit".

| ID | Finding | Audit commit(s) | Status on main | Evidence on origin/main | Port difficulty / risk | Value |
|---|---|---|---|---|---|---|
| OPS-01 | No off-site, encrypted, monitored, restore-tested backup | eaa4dac, 47587b2, 134c299, b33e808 | **PARTIAL** | See the backup verdict. Main: `scripts/ops/pq-backup.sh` (daily DB, weekly uploads, Drive, failure email). Missing: encryption, staleness check, restore tooling and drill. | Re-implement on main's scripts (medium). Wholesale replacement is large and needs VPS work. Risk med. | P0 |
| OPS-02 | `replace-prod-with-local.sh` wipes prod uploads | 4ed7507 | **PRESENT** | Deleted on main by 6726699 (runbook §4b:433-439; AGENTS.md "replace-prod-with-local.sh is gone"). | none | P1 |
| SEC-A1 | No login rate limit on `POST /api/auth/callback/credentials` | a1cb534 (+03b02fe `client-ip.ts`) | **MISSING** | `src/auth.ts:65-98` `authorize()` has no limiter. `:96` `if (!user?.active … \|\| !ok) return null;` records nothing. The only limiter is in the action, `src/lib/actions/auth.ts:84`. | Re-implement: `actions/auth.ts` was rewritten by a16f648. Keep main's action limiter and message, and add `throttle.ts`/`rate-limit.ts` plus the limiter in `authorize()`. Risk med: per-IP keys depend on the proxy chain. | P1 |
| SEC-S1 | Countersigning re-renders and deletes the client-signed PDF | b6a0d16 | **MISSING** | `src/lib/actions/signing.ts:172` `if (document.signingStatus === "SIGNED")`, then re-render, `:183` overwrites `signedPdfName`, `:187` `unlink(… document.signedPdfName)`. `completeSigning` (`signing-client.ts:395-418`) still never writes `signedRevisionId`/`signedPdfPath`. `src/lib/act/outbox.ts:109` says "nothing writes it". | Small conflicts: only `signing-client.ts` (3 hunks) must be hand-merged with 1c78a8d's `revokedAt: null` guard and the ACT! enqueue (put the new writes before `callbackFinished = true`). Risk med. | P1 |
| SEC-D1 | Unfinalize/void → DRAFT → delete cascades an issued quote's history | 59368ac | **MISSING** | `src/lib/actions/documents/lifecycle.ts:113-117` `deleteDraft` checks only `status: "DRAFT"`, then `deleteMany`. `deleteDocument` uses only `canDeleteDocument` (SIGNED). The cascade now also removes `ActOutbox` rows (`schema.prisma:1742` onDelete Cascade), leaving an orphan ACT! opportunity. | Small conflicts: only the lifecycle.ts import hunk rejects. Risk low-med. | P1 |
| SEC-M1 | `isCredit`/`noCommission` read live from the catalogue; an import can flip or delete them and change issued totals | 0c0cb33, acc2ddc, db01bc5, `ops/prod-report-pricing-flags.sql` (d8d90ae) | **MISSING** | No snapshot columns on `DocumentItem` (schema:1188) or `DocumentLine` (:1245). `src/lib/documents/recalc.ts:139` `product: { select: { isCredit: true, noCommission: true } }`, `:226` `isCredit: item.product?.isCredit ?? false`. The same live reads are in `queries/documents-builder.ts:772,955`, `queries/signing.ts:373-404` and `actions/documents/pricing.ts:142-437`. Import: `catalog-xlsx/apply-plan.ts:104-105` pushes `deleteProduct` regardless of `finalDocuments`, and `actions/catalog-import.ts:274-279` runs `tx.product.delete`. | db01bc5: easy, independent. 0c0cb33: small conflicts (recalc.ts and options.ts hunks; consumable lines at options.ts:442-448 need `noCommission` by hand). Migration renamed to z68. acc2ddc: re-apply after 0c0cb33 (it calls `buildEngineInput` from f8b61e6, so adapt or port that first). Risk med (prod backfill). | P1 |
| ARCH-01 | UI finalize gate ignores per-item cap violations | 3522673 | **PRESENT** (different approach) | 5f3ec77: `documents-builder.ts:872` exposes `discountViolations`; `quote-readiness.ts:117-124` adds item-discount, cap, markup and tax rows; `finalize-button.tsx:42,87` gates on `unmetBlockers(rows)`. The rules are still mirrored rather than derived from `validation/finalize.ts`. | Do not port (large; superseded). | P2 |
| ARCH-02/03 | EngineInput built 3×; drifted discount-base copies | f8b61e6 | **PARTIAL** | The Ex Works drift is OBSOLETE: main's tax rewrite persists the charged rate. Three `EngineInput` builders remain: `recalc.ts:219`, `documents-builder.ts:765`, `queries/signing.ts:367`. Hand copies remain at `actions/documents/pricing.ts:160-175,296-322`. Signing passes no region caps (`signing.ts:367-386`). | Re-implement: `engine-input.ts` must take main's `TaxSuggestion`. Risk med (every money path; run the pricing tests). | P2 |
| ARCH-04 / SEC-M5 | Finalize snapshots built from a pre-transaction read | 675b179 | **PARTIAL** | 148f16a fixed the tax and totals part (`finalize.ts:323-358` read `fresh` inside the tx). Still stale: the pre-tx read at `finalize.ts:80-89` feeds the revision snapshot's items, lines and client via `...document` (:351), `entitySnapshot` region fields and `validityDays` (:98). | Re-implement (small change; 5 of 10 hunks fail around the tax blocker and the ACT! enqueue). Risk low-med. | P2 |
| SEC-M2 | Issued quotes re-render breakdowns with live flags | (covered by M1) | **MISSING** | Same live reads as SEC-M1 (`documents-builder.ts:772,955`). | Comes with SEC-M1. | P2 |
| SEC-M4 | Re-saving options resets hand-set option prices to list | 94a74bd | **MISSING** | `actions/documents/options.ts:417` `deleteMany({ … kind: "OPTION" })`, then `:442` `unitPrice: amount`, `:448` `listPrice: amount`; comment at `:445`: "any prior manual edit … is gone". | Re-implement: must exclude EL_INSTALL (hours × rate) and price-0 consumable child lines added on main. `option-line-price.ts` and its test port as-is. Risk low-med. | P2 |
| SEC-A2 | Direct `POST /api/auth/signin/nodemailer` unlimited | a1cb534 | **MISSING** | `src/auth.ts:150-160` `signIn` callback is only `return !!existing?.active`: no pending-challenge check, no limit. The only limiter is in the action, `actions/auth.ts:144`. | Re-implement: minimal port is a `hasPendingChallenge()` refusal in the `signIn` callback. Risk low-med. | P2 |
| SEC-A3 | Catalogue series/options lists always show AU prices | 697c345 | **PRESENT** | 4e68f7a: `src/lib/scope.ts:267-269`, `queries/catalog.ts:9,15-16`, `catalog/[seriesId]/page.tsx:59,72`, `catalog/options/page.tsx:30`. Difference: an ADMIN with no region sees **AU** on main and *no* prices on the audit branch (an open decision). | Do not port. | P2 |
| SEC-A4 | Sessions survive a password change; changing a password does not ask for the current one | 3c360db, e1fb8aa | **MISSING** | No `sessionVersion` on `User`. `src/auth.ts:46` `REVALIDATE_INTERVAL_MS = 5*60*1000`, `:197` returns the token unchanged. `actions/users.ts:452` "The current password is not required.", `:469` `data: { passwordHash }` with no session bump. | Re-implement with moderate conflicts. Migration renamed to z69. The jwt `select` must keep main's `visibleCountries`/`actSyncVisible` (auth.ts:182-183, 224-225). Needs a1cb534's `throttle.ts`. **Risk high**: if the migration is missing, the sign-in `select` throws and nobody can log in. | P2 |
| SEC-A5 | No clickjacking, HSTS or nosniff headers | d861d0a + 690a1a2 | **MISSING** | `next.config.ts:27-43` `headers()` has only the `/sign/:path*` rule (Referrer-Policy, X-Robots-Tag, Cache-Control). No frame-ancestors, X-Frame-Options or HSTS in the repo. Whether nginx adds them cannot be seen from the repo. | Easy: both apply cleanly in sequence. **Squash them; never ship d861d0a alone** (its global CSP would override the SVG sandbox on `/api/files`). Risk low. | P2 |
| SEC-A6 | `setProductionSpec` works on FINAL/SIGNED quotes and accepts EasyLoader sections | f32af19 | **MISSING** | `src/lib/actions/production.ts:71` `documentItem.update({ data: { productionSpec: data } })` has no layout lock. Main added a voltage-only lock at `:64-69`. | Re-implement (small; merge with the voltage block). Risk low. | P2 |
| SEC-S2 | `voidSignature` leaves signing links live | 00616db | **MISSING** | `actions/finalize.ts:655-678` `voidSignature` has no `signingRequest.updateMany` revoke. `signing/link.ts:27-33` has no document-status input. `signAsClient` (`signing-client.ts:212-273`) upserts without a status check. `declineSigning` (`:502-505`) has no FINAL check. 1c78a8d (`signing-client.ts:406`) only stops a *revoked* request completing. | Small conflicts (signing-client.ts helper; drop the audit's `requestStillOpen` hunk, which 1c78a8d supersedes). Port after b6a0d16. Risk low-med. | P2 |
| SEC-S6 | Unfinalize/void check state, then write by id (race with client signing) | 0f90ca7 | **MISSING** | `actions/finalize.ts:584` `tx.document.update({ where: { id: document.id }` after `canUnfinalize`; same at `:664` in void. On main a concurrent `completeSigning` can commit SIGNED and queue the ACT! write, then be overwritten to DRAFT. | Applies once b6a0d16 and 00616db are in. Risk low. | P2 |
| SEC-D5 | Finalize doesn't wait for a pending autosave | ae92f9d | **PARTIAL** | 3e88983 added a per-hook `flush()` (`use-autosave.ts:130`), used only by `item-options-editor.tsx:456`. `finalize-button.tsx:56` calls `finalizeDocument` without a flush (Send, Accept, Unfinalize and Void likewise). Unmount still drops the pending save: `use-autosave.ts:176-182` just `clearTimeout(saveTimer.current)`. | Re-implement on main's rewritten hook: keep the slow-save reporting and 0ce3134's idle-revert. Risk med: a lost edit now also reaches the frozen revision and ACT!. | P2 |
| OPS-03 | Runbook restore can half-fail silently | 4ed7507 (runbook), eaa4dac (`pq-restore.sh`) | **MISSING** | `docs/runbook.md:408,419` `gunzip -c … \| … psql` without `ON_ERROR_STOP`. `:413-420` drop and restore into the live DB. `:428-429` `up -d app` *before* `migrate deploy`. | Re-implement (rewrite the §4 restore text; optionally adapt `pq-restore.sh` to main's file format). Risk low. | P2 |
| OPS-04 | No DB dump before `migrate deploy` | 9daa7c6 (`ops/deploy/deploy.sh`) | **MISSING** | `.github/workflows/deploy.yml:185-186` `docker compose up -d postgres`, then `… prisma migrate deploy`, with no dump. | Re-implement: call main's `/usr/local/bin/pq-backup.sh db` (or a new local-only mode). The audit's call to `ops/backup/pq-backup.sh` would fail closed on the VPS. Risk low-med. | P2 |
| OPS-05/08/09 | Deploy near the 10-min SSH timeout; no concurrency group; VPS pulls main HEAD, not the SHA; `latest` moved before the health check | 9daa7c6 | **MISSING** | `deploy.yml`: no `concurrency:` and no `command_timeout` (git grep finds neither; appleboy defaults to 10 m). `:168` `git pull --ff-only` (HEAD, not `$GITHUB_SHA`). `:124,:136` push `:latest` at build time, before deploy and health. The workflow file is unchanged on main since 60ff2f8, so 9daa7c6 applies CLEAN. | Cherry-pick, then adapt: point the pre-migrate step at main's backup script, and check the detached-SHA checkout against main's ACT! timers, which use `TAG=$(git rev-parse HEAD)` in `/opt/pathquote` (compatible) and against runbook commands that assume a branch checkout. Risk med. | P2 |
| OPS-06 | Schema-only change re-runs two `npm ci` and pushes a new 141 MB tools layer | e73a463 | **MISSING** | `Dockerfile` (unchanged on main): `deps` runs `npm ci` (l.5 of the comment-stripped listing) and `prod-deps` runs `npm ci --omit=dev` (l.10). Both copy `prisma/schema.prisma` *before* installing, so a schema change invalidates both installs. | Cherry-pick (applies CLEAN), but rerun `tests/tools-image-imports.test.ts`: the audit's prune list removes more packages (lucide-react, tiptap, jsdom, dompurify, …) and main's new `act:*` scripts run in the tools image. Risk med. | P2 |
| OPS-07 | Images and container logs grow without limit on the VPS | 9daa7c6 (`prune-images.sh`), 5f0ceaa | **MISSING** | `deploy.yml:219` `docker image prune -f` keeps every SHA-tagged image. `docker-compose.yml` has no `logging:` on any service. Main's `scripts/ops/pathquote.logrotate` rotates only `/var/log/pq-*.log`. | 5f0ceaa applies CLEAN. `prune-images.sh` comes with 9daa7c6. Risk low. | P2 |
| SEC-A8 | 16383² PNG avatar costs about 200 MB RSS | 063840a | **MISSING** | `src/lib/uploads.ts:163` checks only `file.size`. `src/lib/image-derivatives.ts:114` `sharp(originalPath)` has no `limitInputPixels`. | Easy (CLEAN). Risk low. | P3 |
| SEC-A9 | `/api/health` returns raw Prisma error text | c1c436d | **MISSING** | `src/app/api/health/route.ts:44` `error = e instanceof Error ? e.message : …`, `:48` returned in the body; public per `src/proxy.ts:13`. | Easy (CLEAN). Risk low (the deploy reads only ok/schemaOk). | P3 |
| ARCH-05 | `sendQuoteToClient` + `email/quote-send.ts` never called | — | **OPEN** | `actions/signing.ts:492` `sendQuoteToClient` has no caller. `src/lib/email/quote-send.ts` (280 lines) is used only by signing.ts and its test. | Owner decision: finish or delete. | P3 |
| ARCH-07/12 | Lifecycle rules re-inlined in the quote page; 7 action-result shapes | 668f7d5 | **MISSING** | `quotes/[documentId]/page.tsx:845,848,853,858` inline rules. `:879` Download always uses `/quotation-pdf` (a live render, even when SIGNED). `signing/state.ts:36` `isInFlight` is not exported. | Small conflicts. Depends on 59368ac and ae92f9d. Risk low. | P3 |
| ARCH-11 | Redundant `router.refresh()` after revalidating actions | 1084eb0 | **MISSING** | The same 15 redundant calls remain in the 10 files the audit touched (for example accept, send, sign, unfinalize and void buttons with 1 each, `client-action-bar.tsx` with 3). The actions still `revalidatePath` (`finalize.ts:469-470,612-613,…`; `signing.ts:195,455,679,853`). | Re-implement by hand (deleting 1-3 lines each). Risk low-med (click-through check). | P3 |
| ARCH-13..17 | Comment bloat; dead exports; finished scripts; 32 docs; `.claude/` tracked | 24 `docs(comments)`; fcf49b8, d505717, 7d4041b, 04b36bf, 934cb39; 9fe46c0, 57ad267, d2f5179; docs commits | **MISSING** (worse on main) | Comments: base 31%, audit 18%, main 35.5% of non-blank src lines. Dead exports still unused on main: `snapshot.ts:92` `NO_REFERENCES`, `marking-tools.ts:31` `isMarkingTool`, `scope.ts:191-289` test-only helpers, `primitives.tsx:54` `LinesField`, 37 of 38 `z.infer` aliases, plus a new unused `DocumentTaxInput`. Scripts still there: `package.json:16,18-19`, `scripts/add-dmt-option.ts`, `scripts/backfill-product-forms.ts`, `scripts/verify-quote-document-migration.ts`. Docs: 37 files, about 21.8k lines (main removed 5 and added 9). `.claude/`: 71 tracked files despite `.gitignore:73`. | Dead code and scripts: easy or small conflicts (fcf49b8, 9fe46c0, d2f5179 apply CLEAN). Docs and comments: do not port the diffs. Docs moves would break links in main's new ACT! docs and in `z60_act_sync` to `docs/superpowers/specs/2026-09-08-act-integration-design.md`. | P3 |
| OPS-10 | zod ships to the builder and client pages | 82055e9 | **MISSING** (worse) | Client files importing zod modules: `components/builder/items-list.tsx:27` `easyLoaderSpecSchema` (new on main), `:29`; `production-spec-editor.tsx:22`; `terms-documents-panel.tsx:11` `quoteTermsSchema`; `clients/industry-picker.tsx:12`. | Large (29 files drifted). Redo as a fresh task. Risk med. | P3 |
| OPS-11/13 | `xlsx@0.18.5` (2 high advisories, admin-uploaded input); `fflate` unused | 2d63568 | **MISSING** | `package.json:67` `"xlsx": "^0.18.5"`, `:53` `"fflate": "^0.8.3"`. Used at runtime by `catalog-xlsx/parse.ts:16`. | Easy (CLEAN; then `npm ci`, catalog-export test). Risk low. | P3 (highest-value P3) |
| OPS-14/15/16/17 | Tools image carries browser libs; docs-only commits redeploy; actions not pinned; root runtime | e73a463, 9daa7c6 | **MISSING** | Tools prune at `Dockerfile` prod-deps removes only swc, next, sharp and @img. `deploy.yml:3-6` has no `paths-ignore`, so main's many docs-only commits each redeploy. Actions use tags (`actions/checkout@v4` :36, `appleboy/ssh-action@v1` :146). The `run` stage has no `USER` (the audit also left non-root as a prod approval). | Comes with e73a463 and 9daa7c6. Risk low-med. | P3 |
| UI-01 | Builder tabs run off-screen at 360/390 px; "History" unreachable | d90f84e | **MISSING** (owner confirmed) | `components/builder/builder-tabs.tsx:76` tablist `className="flex gap-1"`, comment `:68-71` "No overflow of any kind … three tabs fit inside a 390px phone", but `TAB_META` has 4 tabs (`:12-15` Build, Quote setup, Order forms, History). `src/app/globals.css:239` `overflow-x: clip`. Neither file changed on main. | **Easy (CLEAN).** Risk low. | P1 |
| UI-02 | Long company name hides the client card's "Change" | 911c4f1 | **PRESENT** (0925875) | `components/builder/client-section.tsx:293` `flex min-w-0 items-start gap-3`; `:319` Change `shrink-0 … min-h-11 min-w-11`. Not done: the `.touch-target` utility and the small hit areas at `:280,:355,:437` (UI-14, P3). | Re-implement just the CSS utility and 3 classNames. Risk low. | P1 (done); remainder P3 |
| UI-03 | Signature pad rescales x/y independently on rotate (squashed signature) | 0a8b123, 00c4191 | **MISSING** | `components/signing/signature-pad.tsx:120-128` `scaleX = newWidth / oldWidth … y: point.y * scaleY`. The file is unchanged on main. | Easy (0a8b123 CLEAN, then 00c4191). Risk low. | P1 |
| UI-04 | Autosave drops the last edit when leaving within 800 ms | ae92f9d, 2250f5f | **PARTIAL** | 2250f5f's case (options sheet close) is PRESENT via 3e88983 (`item-options-editor.tsx:450-457` `void autosave.flush()`). The general unmount and pagehide case is MISSING (`use-autosave.ts:176-182`). | See SEC-D5. | P2 |
| UI-05/06/23 | Explicit-save forms lose edits silently; double-click "New quote" creates two drafts; duplicate contacts | ee6ce0a, ffbf501, 6eef3e7 | **MISSING** | No `SubmitButton`/`useFormStatus` and no `beforeunload` in src. `src/app/(app)/page.tsx:69-70` and `quotes/page.tsx:65-66` `<form action={createDraft}><Button type="submit"…>`. `company-form.tsx:217-218` and `contact-form.tsx:107-108` likewise. | 6eef3e7 easy (CLEAN). ee6ce0a and ffbf501 small conflicts: retarget to `src/components/users/commission-tiers-form.tsx`, which replaced `settings/commission-tiers-form.tsx`. Guard risk med (global capture-phase click handler). | P2 |
| UI-07/08/11 | Price-override breakdown collapses; 166 px sticky header; fixed 794 px preview | ae4f8d5, d90f84e, 9b31550, 17d1045 (/sign) | **MISSING** | `item-breakdown-editor.tsx:464` `inline-flex … pr-5`, `:289` no overflow guard. `quote-bar.tsx:78,97` 3-row header unchanged. `quotes/[documentId]/quotation/page.tsx:258-259` `overflow-x-auto … w-fit` with no `SheetViewport`. `/sign/[token]/page.tsx:89` has no viewport fit. | ae4f8d5, 9b31550 and d90f84e are easy (CLEAN). 17d1045 needs 9b31550, fd769b2 and 32bfbfe first. Risk low. | P2 |
| UI-09 | "5% off the subtotal", but no-commission lines take no discount | 15f8f2c | **MISSING** | `builder/document-discount-field.tsx:71` `` `${discountValue}% off the subtotal` ``; `sheet/item-breakdown.tsx:146`; `sheet/sections/investment-summary.tsx:134`. The rule still holds: `src/lib/pricing.ts:375,389`. | Small conflicts (investment-summary context). Risk low (PDF wording; the test is updated in the same commit). | P2 |
| UI-10 | A failed "Send to client" is recorded as sent | af293ec | **MISSING** | `actions/signing.ts:440-443` and `:642-645` revoke rather than delete the undelivered request, and the status restore is unguarded. | Easy (CLEAN). Risk low. | P2 |
| UI-13..22 | scroll-padding, touch targets, confirm focus, a11y, contrast, display name, settings nav, catalog clipping | 1793978, efb6035, 3e5691f, 219566f, 2947bf9, fd769b2, 7c59af0, 6c21927, e8bb0cb | **MISSING** (the readiness-link half of UI-14 is OBSOLETE) | No `scroll-padding` in src. `ui/button.tsx` sizes `h-8`/`size-8` with no `pointer-coarse`. `ui-kit/confirm-dialog.tsx:84` autoFocus on the confirm button. `ui-kit/field-row.tsx:59-66` hint is not wired. `src/lib/avatar.ts:13-23` 500-shade palette. 22 `name ?? email` sites; `production-forms/context.ts:111,164` `authorName: document.author.name ?? ""`. `settings/settings-nav.tsx:41` has no scroll-into-view. `catalog/product-reorder-list.tsx:134-184`. `forms/form-sheet.tsx:192` Company field not `full`. | Mostly easy (3e5691f, 6c21927, e8bb0cb, 2947bf9 and 1793978 CLEAN); small conflicts for 219566f, fd769b2, 7c59af0 and efb6035 (drop its readiness hunk). Port 1793978 and 7c59af0 **after** d90f84e. Risk low. | P3 |

## Per-commit table (83 triaged commits, in branch order)

| Commit | Subject (short) | Finding | Apply on main | Status | Note |
|---|---|---|---|---|---|
| 2d63568 | xlsx 0.20.3, drop fflate | OPS-11/13 | CLEAN | MISSING | Port. |
| f918a11 | drop finished specs/plans/mockups/.obsidian | ARCH-16 | FAIL (docx already gone) | PARTIAL | Delete `docs/.obsidian/` and `docs/redesign/*.html` by hand if wanted. |
| c1c436d | health: no raw Prisma errors | SEC-A9 | CLEAN | MISSING | Port. |
| d861d0a | security headers | SEC-A5 | CLEAN | MISSING | Port squashed with 690a1a2. |
| 063840a | image pixel cap | SEC-A8 | CLEAN | MISSING | Port. |
| 697c345 | catalog lists priced in viewer's region | SEC-A3 | FAIL | PRESENT (4e68f7a) | Skip. |
| 0c0cb33 | snapshot isCredit/noCommission | SEC-M1/M2 | FAIL | MISSING | Port with acc2ddc; migration → z68. |
| db01bc5 | import deactivates referenced rows | SEC-M1 | FAIL (1 line, export.ts) | MISSING | Port; independent. |
| b6a0d16 | keep client-signed PDF on countersign | SEC-S1 | FAIL (signing-client.ts) | MISSING | Port; hand-merge with 1c78a8d and the ACT! enqueue. |
| 15c851f | condense status/signing/documents specs | ARCH-16 | FAIL | MISSING (docs) | Do not port as a diff. |
| 7653605 | production-forms reference doc | ARCH-16 | FAIL | MISSING (docs) | Do not port as a diff. |
| 5a9a3c1 | move ACT! design/vendor spec to reference/ | ARCH-16 | FAIL | PARTIAL | Do not port: main's new docs link the old path. |
| 00616db | close signing links when quote leaves FINAL | SEC-S2 | FAIL (signing-client.ts) | MISSING | Port after b6a0d16. |
| f8b61e6 | one engine-input builder | ARCH-02/03 | FAIL (4 files) | PARTIAL | Re-implement around main's tax suggestion. |
| ab48e3f | catalogue comments → reference docs | ARCH-16 | FAIL | MISSING (docs) | Skip. |
| c06bd12 | project README | ARCH-16 | CLEAN | MISSING (docs) | Optional. |
| f04dd43 | status-model: which events are written | ARCH-16 | FAIL (file absent) | MISSING (docs) | Skip, or port with 15c851f by hand. |
| 03b02fe | signer IP = the hop nginx saw | security | FAIL (signing-client.ts) | MISSING | Port; also needed by a1cb534. Main `signing-client.ts:124-135` takes the first, forgeable hop. |
| 59368ac | never delete an issued quote's history | SEC-D1 | FAIL (lifecycle.ts import) | MISSING | Port. |
| a1cb534 | sign-in limits in the providers | SEC-A1/A2 | FAIL | MISSING | Re-implement on main's rewritten actions/auth.ts. |
| 3522673 | gate Finalize on server blockers | ARCH-01 | FAIL (8 files) | PRESENT (5f3ec77) | Skip. |
| 0f90ca7 | guard unfinalize/void writes | SEC-S6 | FAIL (finalize.ts) | MISSING | Port after 00616db. |
| f32af19 | EasyLoader layout out of setProductionSpec | SEC-A6 | FAIL (production.ts) | MISSING | Re-implement next to the voltage lock. |
| 675b179 | snapshots from the post-recalc read | ARCH-04 | FAIL (finalize.ts) | PARTIAL (148f16a) | Re-implement the remainder. |
| 94a74bd | keep hand-set option price | SEC-M4 | FAIL (options.ts) | MISSING | Re-implement; exclude EL_INSTALL and consumables. |
| e73a463 | Docker: install once, prune tools | OPS-06/14 | CLEAN | MISSING | Port; rerun the tools-image test against the act:* scripts. |
| 5f0ceaa | compose log rotation, parametrize image/port | OPS-07 | CLEAN | MISSING | Port. |
| eaa4dac | encrypted off-site backup, restore, staleness check | OPS-01/03 | CLEAN (new files) | PARTIAL | Do not drop in; extend main's scripts (see the backup verdict). |
| 9daa7c6 | deploy: SHA checkout, pre-migrate dump, smoke, pinned actions | OPS-04/05/08/09/15/17 | CLEAN | MISSING | Port, adapted to main's backup script. |
| 690a1a2 | keep SVG sandbox CSP on /api/files | SEC-A5 | FAIL (needs d861d0a) | MISSING | Squash with d861d0a. |
| ae92f9d | flush autosaves before lifecycle actions and on unmount | SEC-D5/UI-04 | FAIL | PARTIAL (3e88983) | Re-implement on main's hook. |
| af293ec | failed send leaves no signing request | UI-10 | CLEAN | MISSING | Port. |
| 0a8b123 | signature keeps its shape on resize | UI-03 | CLEAN | MISSING | Port. |
| acc2ddc | drafts follow catalogue flags; FINAL frozen | SEC-M1 | FAIL (needs 0c0cb33) | MISSING | Port with 0c0cb33. |
| 106a0eb | lifecycle errors not all "Forbidden" | UI | FAIL (context) | MISSING | Port; trivial by hand. Main: `accept-button.tsx:43-44`, `unfinalize-button.tsx:59-60`, `void-signature-button.tsx:42-43` `catch { setError("Forbidden") }`. |
| 668f7d5 | quote page uses signing/state rules | ARCH-07 | FAIL | MISSING | Port after 59368ac. |
| d23b59c | type-check tests; revision PDF mkdir | tests | CLEAN | MISSING | Port, but `typecheck` goes red: 9 newer test type errors on main (act-merge, commission-tiers-editor, roll-feed, standard-fitment) must be fixed in the same change. `revision.ts:49` writes without `mkdir`. |
| d90f84e | fit the quote header's tabs on phones | UI-01/08 | CLEAN | MISSING | **Port first.** |
| 47587b2 | smaller off-site retention, CI retention test | OPS-01 | FAIL (needs eaa4dac) | MISSING | Only with the audit backup system. |
| 4ed7507 | runbook rewrite; retire replace-prod | OPS-02/03 | FAIL | PARTIAL | Script deletion PRESENT (6726699). Rewrite runbook §4 restore by hand. |
| b33e808 | ops scripts executable | OPS-01 | FAIL (files absent) | MISSING | Only with the ops files. |
| 134c299 | back up an unmigrated DB; coprocess exit | OPS-01 | FAIL (files absent) | MISSING | Only with the ops files. |
| f95e5bb | delete the unrendered StickyFooter | ARCH-14 | FAIL | PRESENT (b18d1fa) | Skip. |
| fcf49b8 | delete exports nothing calls | ARCH-14 | CLEAN | MISSING | Port (cheap). |
| d505717 | delete test-only helpers | ARCH-14 | FAIL | MISSING | Optional; small conflicts. |
| 7d4041b | drop unused z.infer aliases | ARCH-14 | FAIL | MISSING | Optional; regenerate the list (now 37 + `DocumentTaxInput`). |
| 911c4f1 | client card Change button in reach | UI-02/14 | FAIL | PARTIAL (0925875) | Take only the `.touch-target` CSS and 3 classNames. |
| 9fe46c0 | delete catalog:build-seed-data | ARCH-15 | CLEAN | MISSING | Port (cheap). |
| 57ad267 | delete catalog:add-dmt, backfill-forms | ARCH-15 | FAIL (package.json) | MISSING | Port (cheap). |
| d2f5179 | delete verify-quote-document-migration.ts | ARCH-15 | CLEAN | MISSING | Port (cheap). |
| ccbea51 | README: how a fresh DB gets industries | ARCH-16 | FAIL (needs c06bd12) | MISSING (docs) | Optional, with c06bd12. |
| 04b36bf | unexport three values | ARCH-14 | FAIL | MISSING | Optional (3 words). |
| 6eef3e7 | SubmitButton: no double submits | UI-06/23 | CLEAN | MISSING | Port. |
| f52e6d2 | email doc points at signing reference | ARCH-16 | CLEAN | MISSING (docs) | Skip; it points at a doc main does not have. |
| ae4f8d5 | item breakdown readable after override | UI-07 | CLEAN | MISSING | Port. |
| 15f8f2c | discount applies to eligible items | UI-09 | FAIL (small) | MISSING | Port. |
| 9b31550 | quotation preview fits a phone | UI-11 | CLEAN | MISSING | Port. |
| ee6ce0a | unsaved-changes guard | UI-05 | FAIL | MISSING | Port; retarget commission-tiers to `users/`. |
| ffbf501 | guard sees commission tier rows | UI-05 | FAIL | MISSING | Port with ee6ce0a. |
| 1793978 | focused fields clear of sticky headers | UI-13 | CLEAN | MISSING | Port after d90f84e (assumes the shorter header). |
| efb6035 | 44 px touch targets | UI-14 | FAIL | PARTIAL | `button.tsx` part MISSING; readiness part OBSOLETE (5f3ec77 removed the links). |
| 3e5691f | confirm dialog focus on Cancel | UI-15/16 | CLEAN | MISSING | Port. |
| 6c21927 | catalog prices on card at phone width | UI-18/22 | CLEAN | MISSING | Port. |
| 7c59af0 | settings pill scrolled into view | UI-17 | FAIL | MISSING | Port after d90f84e (it refactors that commit's effect into `useSelectedInView`). |
| 14520e1 | purge-quotes removes revision PDFs | scripts | FAIL (header) | MISSING | Port. `scripts/purge-quotes.ts:83-84` only deletes `signedPdfName`. |
| 219566f | field hints/errors tied to controls | UI-19 | FAIL (client-section imports) | MISSING | Port. |
| 3c360db | revocable sessions (sessionVersion) | SEC-A4 | FAIL | MISSING | Re-implement; migration → z69; high risk. |
| e1fb8aa | current password; sign out other sessions | SEC-A4 | FAIL | MISSING | Port after 3c360db and a1cb534. |
| fd769b2 | name users without a name by email | UI-20 | FAIL (4 files) | MISSING | Port. |
| e8bb0cb | wrap long company name on order forms | UI-22 | CLEAN | MISSING | Port; recheck the one-page A4 fit. |
| 2947bf9 | readable avatar initials | UI-21 | CLEAN | MISSING | Port. |
| 32bfbfe | SMTP auth only when SMTP_USER set | env | CLEAN | MISSING | Port. `email/transport.ts:20-27` always sends `auth`. |
| 17d1045 | /sign fits a phone; consistent names | UI-11 | FAIL | MISSING | Port after 9b31550, fd769b2 and 32bfbfe. Main `auth.ts:102-108` still has an unconditional SMTP auth. |
| 1084eb0 | drop redundant router.refresh() | ARCH-11 | FAIL | MISSING | Redo by hand. |
| 2250f5f | save last options change on sheet close | UI-04 | FAIL | PRESENT (3e88983) | Skip. |
| 82055e9 | keep zod out of client bundles | OPS-10 | FAIL (29 files) | MISSING | Redo as a fresh task. |
| a844543 | "Go and fill it in" opens the machine | — | FAIL | OBSOLETE | Main removed readiness links on purpose (5f3ec77). |
| bacff13 | keep session cookie on magic-link verify | auth bug | FAIL (file exists) | PRESENT (a16f648) | Skip. `src/lib/auth/magic-verify-response.ts:61-69`. |
| c2483d9 | magic link returns to origin page | auth UX | FAIL | PRESENT (a16f648) | Skip. `login-form.tsx:49`, `actions/auth.ts:166,179`. |
| 934cb39 | remove unused LinesField + CSS | ARCH-14 | FAIL | MISSING | Optional; by hand. |
| 00c4191 | signature keeps size and edges on resize | UI-03 | FAIL (needs 0a8b123) | MISSING | Port with 0a8b123. |
| 96b2209 | challenge cookie for refused addresses too | enumeration | FAIL | MISSING | Re-implement (about 8 lines). `actions/auth.ts:190-191` returns success without the cookie; `:215` sets it only on a real send, so the cookie's presence reveals a registered address. |
| d8d90ae | final worklog + `ops/prod-report-pricing-flags.sql` | SEC-M1 | FAIL (worklog absent) | MISSING (SQL) | Take only the SQL, with 0c0cb33; rename z51 → z68 inside it. |

## Recommended port batches (priority order)

Each batch is a branch off current main with its own PR. Batches 1 and 2 touch disjoint files and can run in parallel. Batch 2 must land before Batch 4, so the pricing-flag migration is protected by a pre-migrate dump.

### Batch 1: Clean, independent quick wins (P1/P2, low risk, about 1 day)

Commits:

- d90f84e (UI-01/08), then 1793978 (UI-13)
- 0a8b123 + 00c4191 (UI-03)
- af293ec (UI-10)
- db01bc5 (SEC-M1 import guard)
- d861d0a + 690a1a2 squashed (SEC-A5)
- c1c436d (SEC-A9)
- 063840a (SEC-A8)
- 32bfbfe (SMTP)
- 2d63568 (xlsx/fflate; then `npm ci`)
- 6eef3e7 (UI-06/23)
- ae4f8d5 (UI-07)
- 9b31550 (UI-11)
- 15f8f2c (UI-09)

Expected conflicts:

- db01bc5: one README line in `catalog-xlsx/export.ts`.
- 15f8f2c: context in `investment-summary.tsx`.
- Everything else applied CLEAN to main.

Checks:

- `npm test`, including pdf.test.ts after 15f8f2c.
- Phone-width check of the builder tabs and `/sign`.
- Confirm the HSTS/CSP headers don't clash with whatever nginx already sends.

### Batch 2: Backup and deploy safety net (OPS-01 P0 remainder, OPS-03/04/05/07/08/09/15/17, OPS-06)

Re-implement on top of main's `scripts/ops/pq-backup.sh`; do not install the audit's `ops/backup`:

1. **Deploy.** Port 9daa7c6 (deploy.yml applies CLEAN) and `ops/deploy/{deploy.sh,prune-images.sh,smoke-test.sh}`. Point the pre-migrate step at main's backup script, run as a local-only DB dump that fails the deploy if it fails.
2. **Runbook.** Rewrite runbook §4 "Restore procedure" (`ON_ERROR_STOP`, restore into a scratch DB, migrate before starting the app). Optionally adapt `pq-restore.sh` to main's `.sql.gz` and `.tar.gz` files.
3. **Staleness check.** Add a check and timer modelled on `pq-backup-check.sh`, alerting through `pq-backup-alert@`.
4. **Encryption.** age encryption before `rclone sync`. The owner creates the keypair offline.
5. **Compose and Dockerfile.** 5f0ceaa (CLEAN) and e73a463 (CLEAN).

Expected conflicts:

- The detached-SHA checkout versus main's ACT! timers, which read `git rev-parse HEAD` (compatible), and versus runbook steps that `git pull` or `git checkout` on the VPS.
- `tests/tools-image-imports.test.ts` must pass with main's `act:*` scripts after the wider tools prune.
- `.github/workflows/deploy.yml` adds `paths-ignore`; confirm that docs-only ACT! runbook commits are meant to skip deploy.

This batch needs VPS work: install the new units and run one restore drill.

### Batch 3: Signed-record integrity and lifecycle guards (SEC-S1, SEC-D1, SEC-S2, SEC-S6, SEC-A6, P1/P2)

Order:

1. 03b02fe (client-ip)
2. b6a0d16 (S1)
3. 00616db (S2)
4. 0f90ca7 (S6)
5. 59368ac (D1)
6. f32af19 (A6, re-implemented next to the voltage lock)
7. 106a0eb
8. 668f7d5 (ARCH-07)
9. 14520e1
10. The `revision.ts` mkdir line from d23b59c

Expected conflicts:

- **`src/lib/actions/signing-client.ts` `completeSigning`.** Merge with main's 1c78a8d (`revokedAt: null` claim, `callbackFinished`) and the ACT! outbox enqueue. Put `CLIENT_SIGNED`, `recordSignedRevision` and the FINAL claim before `callbackFinished = true`. Drop the audit's `requestStillOpen` re-check.
- **`finalize.ts` voidSignature hunks.** b6a0d16, 00616db and 0f90ca7 share them, so keep that order.
- **`lifecycle.ts` imports.**
- **`src/lib/act/outbox.ts:109` comment.** Update it, because `signedRevisionId` will now be written.
- **ACT! dependency.** `src/lib/act/drain-rules.ts:97-99` depends on `voidSignature` leaving `acceptedAt` set. Do not change that here.

Then do SEC-D5/UI-04 (ae92f9d), re-implemented on main's autosave hook, keeping slow-save reporting.

### Batch 4: Pricing-flag snapshot and finalize freshness (SEC-M1/M2 P1, SEC-M4, ARCH-04, ARCH-02/03, P2)

Order:

1. f8b61e6, re-implemented with main's `TaxSuggestion`. Alternatively skip it and adapt acc2ddc to main's inline EngineInput.
2. 0c0cb33 + acc2ddc, with the migration renamed `z68_snapshot_pricing_flags`. Add `noCommission` by hand on consumable child lines (`options.ts:442-448`).
3. `ops/prod-report-pricing-flags.sql`, renamed references.
4. 94a74bd, re-implemented to exclude EL_INSTALL and consumables.
5. The 675b179 remainder: read items, lines, client and region once inside the tx (`finalize.ts:80-89,351`).

Expected conflicts:

- `recalc.ts` (main added `parseCommissionTiers` and sequential option lookups).
- `queries/signing.ts`, `documents-builder.ts`, `actions/documents/pricing.ts`.
- `finalize.ts` (main's tax blocker, `fresh` read and ACT! enqueue).

Deploy checks:

- Batch 2's pre-migrate dump must be live.
- After the deploy, run the read-only SQL.
- Verify every FINAL total is byte-identical, as the audit did in a rolled-back transaction.

### Batch 5: Auth hardening (SEC-A1 P1, SEC-A2, SEC-A4 P2, enumeration)

Order:

1. a1cb534, re-implemented: `throttle.ts`/`rate-limit.ts`, the limiter in `authorize()`, and a `hasPendingChallenge()` refusal in the `signIn` callback. Keep main's explicit "Too many sign-in links" message.
2. 96b2209, by hand.
3. 3c360db, with the migration renamed `z69_user_session_version`. Keep `visibleCountries`/`actSyncVisible` in the jwt select and token, and consider adding `sessionVersion` to the health probe.
4. e1fb8aa.

Expected conflicts:

- `src/auth.ts`: main added `SIGN_IN_PATH` and new token fields.
- `actions/auth.ts`: rewritten by a16f648.
- `actions/users.ts` and `settings/users/[userId]/page.tsx`: main added about 105 lines.

Risk is high: a missing migration locks everyone out. Before porting the per-IP keys, confirm the production proxy chain (nginx `$proxy_add_x_forwarded_for`, no CDN in front). Do a live login, magic-link and password-change test.

### Backlog (P3, take when touching the files)

**UI P3:**

- 3e5691f
- 6c21927
- e8bb0cb
- 2947bf9
- 219566f
- fd769b2, then 17d1045
- 7c59af0 (after d90f84e)
- `button.tsx` part of efb6035
- `.touch-target` part of 911c4f1
- ee6ce0a + ffbf501 (UI-05, a P2 kept here because the guard carries medium risk)

**Cleanup:**

- fcf49b8, 9fe46c0, d2f5179, 57ad267 (cheap)
- d505717, 7d4041b, 04b36bf, 934cb39 (by hand)
- 1084eb0 (ARCH-11) by hand
- OPS-10 as a fresh task
- d23b59c, with the 9 test fixes
- Delete `docs/.obsidian` and `docs/redesign` mockups by hand

**Do not port:**

- The 24 comment trims.
- The docs move commits.
- 3522673, 697c345, f95e5bb, 2250f5f, bacff13, c2483d9 (PRESENT on main).
- a844543 (OBSOLETE).

## Owner decisions still open (from the worklog, re-checked on main)

**Production approvals (worklog list):**

1. **Backup activation.** Superseded: main has its own active backup. The decision is now whether to add encryption, a staleness check, a restore script, a pre-migrate dump and nightly uploads to it (recommended), or to switch to the audit's system.
2. **Merge `audit/modernization` → main.** Moot: the branch cannot be merged (235 main commits, colliding z51/z52). Port by batches instead.
3. **Non-root runtime container.** Still open: main's `Dockerfile` run stage has no `USER`, and the audit did not do it either. A one-time chown of the uploads volume is needed.
4. **`.claude/` tracked despite `.gitignore`.** Still open: 71 files tracked on main, including `.claude/settings.local.json`. Untracking deletes the local copies on the next pull.
5. **VPS IP, SSH port and key filename in git history.** On main they are now also in the live runbook by design (1b7c4be; `scp -P 3498 … root@74.208.106.34`). Decide whether that is acceptable.

**Business decisions:**

- **ARCH-05.** Finish the send dialog or delete `sendQuoteToClient`, `quote-send.ts` and `QuoteEmail`. Still dead on main.
- **SEC-M3.** A negative custom line and a trade-in product give different totals. Still true by reading the code: `validation/documents.ts:89-92` accepts signed prices, and `pricing.ts:954` adds back only `isCredit` items. Not run as a calculation.
- **SEC-S4.** An old or revoked link shows the signed quote after signing. Still true: `signing/link.ts:34` returns `completed` for SIGNED before it checks `revokedAt`.
- **SEC-A7.** An ADMIN can grant themselves DEVELOPER. Still true: `validation/users.ts:165-177` only blocks self-demotion, and `actions/users.ts:127-158` writes the role.
- **SEC-D9.** The quote-number year comes from the server clock. Still `new Date().getFullYear()` at `finalize.ts:242`, in the container's TZ, which is UTC unless TZ is set.
- **Cross-region prices.** Whether RMs and managers may see other regions' prices; unchanged.
- **RPO.** Main is now 24 h for the DB and **up to 7 days for uploads** (signed PDFs, signature PNGs), because files are backed up weekly.
- **ADMIN without a region on catalogue pages.** Main shows AU (`scope.ts:256-269`); the audit showed nothing.
- **Prisma `relationJoins`.** Enable the preview or wait, because of the "query while executing" log noise. Not enabled on main.

**Sign package decisions (relevant once Batch 3 is ported):**

- After countersign, the client's link serves the countersigned copy rather than their own. Today main is worse: the client's own PDF is deleted (SEC-S1).
- An ADMIN can delete an issued, never-signed quote. On main any in-scope manager can delete a reopened issued quote, and it cascades `ActOutbox` rows.
- The screen side printed on the quote stays editable after finalize.
- `voidSignature` ignores `acceptedAt`. Main's ACT! drain now relies on this (`act/drain-rules.ts:97-99`).

**Session package decisions (relevant once Batch 5 is ported):**

- A magic-link-only user can set a first password with only a session.
- An admin can no longer set their own password from the admin user screen.
- "Sign out other sessions" asks for no password.
- In-memory limiters reset on restart.

**Dead code kept for decisions (all still on main):**

- `scripts/migrate-catalog-v2.ts`
- `scripts/backfill-quote-revisions.ts`
- `scripts/lib/quote-document-bodies.ts`, with its test
- `scripts/repair-z35-signing-request-drift.sql`

## Caveats

- The per-commit apply check applies each commit on its own, so a FAIL is often caused by a missing earlier audit commit. Real conflict sizes were judged by reading the hunks against main's diff.
- Nothing was built or run against main, except one `tsc -p tests` run on an export of origin/main, used for the d23b59c note.
- UI statuses come from reading markup and CSS, not from rendering, except UI-01, which the owner confirmed.
- nginx configuration is not in the repo, so whether it already adds security headers (SEC-A5) is unknown.
- No restore drill of main's backups is recorded in the repo. That does not prove one was never done.
