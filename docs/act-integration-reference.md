# ACT! Web API — Integration Reference

**Date:** 2026-10-05
**Status:** Verified against the live installation
**Design document:** `docs/superpowers/specs/2026-09-08-act-integration-design.md`

Everything here was read from the running system, not from vendor documentation. No third-party development is required: the Act! Web API is installed, running, and serves the production database.

---

## 1. The installation

| | |
|---|---|
| Act! client | v24.0.204.0, Update 8 |
| Act! Web API | v1.1.524.0 |
| Database | `Pathfinder`, 3.7 GB, `C:\ActData\Pathfinder.ADF` |
| Database role | **Publisher** — managers' laptops hold synchronised remote databases |
| SQL host | `PF-SQL`, instance `ACT7` |
| Sync | Internet sync via `act.pathfinderaus.com.au` (Act! Network Sync Service on IIS) |
| IIS applications | `/act.web.api`, `/APFW`, `/AFWValidationSrvc` |
| Act! users | 20, of whom 14 appear as Record Manager |
| Licences | 7 active |

Because remote databases exist, **nothing may write to the database outside the Act! business layer.** Direct SQL writes would not be queued for replication and would be invisible to every laptop. The Web API is the only write path used here.

## 2. Authentication

```
GET  /act.web.api/authorize
     Authorization: Basic base64(username:password)
     Act-Database-Name: Pathfinder
  → JWT, valid 65 minutes (AuthTimeoutInMinutes)
```

Subsequent calls:

```
Authorization: Bearer <jwt>
Act-Database-Name: Pathfinder
```

The username is the Act! **display name**, exactly as it appears in `Tools → Manage Users` — `John Hollo`, not `john`. A wrong username or an unregistered database name both return a bare `401` with no body, so the two are indistinguishable from the response alone.

**The integration account is `Marketing`**, id `d90f208e-6468-4251-89d8-4937b0c70182`, promoted to the Manager role on 2026-10-05. The name is historical — it was a dormant account reused for its licence seat — and it is what will appear as the author of every history record and note the integration writes. Renaming it to something self-explanatory is deferred, not rejected; the credentials live in configuration, so a rename is a one-line change on our side.

Error codes documented by the API: `401` unauthorized, `403` forbidden, `4030` Act! incompatibility, `4031` subscription required, `4032` API access permission required.

Tokens are signed with `BearerKey` from `C:\Program Files\ACT\Act.Web.API\web.config`.

### Permissions the integration account needs

`GET /api/users/{userId}/permissions` returns the effective list, which is the fastest way to diagnose a refusal. An administrator has 93 permissions; a standard user has 31.

| Permission | Why |
|---|---|
| **Web API Access** | Without it `/authorize` returns `4032` regardless of the password. This is the literal name of the permission. |
| **Access All Non-Private Data** | Without it the sync sees only records where the service account is itself the Record Manager — effectively nothing. |
| **Manage Other Users Contacts** | PathQuote fills empty fields on contacts owned by salespeople. |
| **Manage Other Users Companies** | The same for companies, including the shipping address. |
| **Link/Unlink Other Users Contacts from Company records** | Linking someone else's contact to a company. |
| **Manage Other Users Opportunities** | Write-back against opportunities owned by others. |

That set corresponds to the **Manager** role. Standard is not enough: it carries only the "My" variants of each permission.

Administrator is deliberately not used. It adds `Manage Users`, `Define Fields`, `Delete Database`, `Restore Database`, `Password Policy Management` and the whole Act! Marketing Automation block. If the credentials ever leak, the difference between Manager and Administrator is the difference between damaged data and a destroyed database.

**`Define Fields` is never granted to the service account.** It is needed exactly once, to create the five `PQ ` fields; do that under an administrator login and leave the service account unable to alter the schema.

## 3. Endpoints in use

| Purpose | Endpoint |
|---|---|
| Contacts | `GET,POST /api/contacts` · `GET,PUT,PATCH /api/contacts/{id}` |
| Companies | `GET,POST /api/companies` · `GET,PUT,PATCH /api/companies/{id}` |
| Link contact ↔ company | `PUT,DELETE /api/contacts/{contactId}/associated-companies/{companyId}` |
| Notes | `POST /api/notes` · `GET /api/contacts/{id}/notes` |
| History | `GET,POST /api/History` · `GET /api/contacts/{id}/history` |
| Activities | `/api/activities/*` |
| Opportunities | `GET,POST /api/opportunities` · `/api/opportunities/{id}/products` |
| Opportunity processes | `GET /api/opportunities/processes` · `/stages` |
| History types | `GET /api/history-types` |
| Field metadata | `GET /api/metadata/{recordType}/fields` |
| Picklists | `GET /api/metadata/{recordType}/picklists` |
| Create a custom field | `POST /api/metadata/{recordType}/fields` |
| Users | `GET /api/users` |
| Webhooks | `GET,POST /api/webhooks` · `/{id}/suspend` · `/{id}/continue` |
| Duplicate handling | `PUT /api/contacts/duplicate` |

OData query options work on collection endpoints. Verified: `$top`, `$filter`, `$orderby`.

### Response shape is not consistent

`/api/contacts` and `/api/companies` return `{ "value": [...], "Count": n }`. `/api/users` and `/api/users/{id}/permissions` return a bare array. The client must handle both rather than assume a common envelope — silently reading `.value` off a bare array yields nothing and looks exactly like a permissions failure.

`Count` on a paged response is the size of the page, not the total. There is no total without paging to the end.

`$top` caps out: a request for 5000 returns at most 5000, so two different accounts both hitting the ceiling prove nothing about their relative access. Compare them on a window narrow enough to come in under the cap.

### Verified access, 2026-10-05

Admin and service account compared over `edited gt 2026-06-01`: 2042 records for the administrator, 2040 for the service account. The difference is exactly the two private contacts in that window, which the integration excludes anyway. Cross-owner reads work; the service account sees everything it needs and nothing it should not.

## 4. Field mapping — Contact

The Act! display name is not the API key. Several stock "user" slots were renamed years ago, so `Industry` lives in `user6`. Always resolve through `GET /api/metadata/contact/fields`, never by guessing.

**Identity and sync**

| Act! display name | API path | Notes |
|---|---|---|
| — | `id` | uuid, the integration anchor |
| — | `companyID` | uuid; empty string when the contact is not linked to a Company record |
| — | `created` | |
| — | `edited` | **delta cursor** |
| — | `editedBy`, `recordOwner`, `recordManager`, `recordManagerID` | |
| Contact Type | `contactType` | filter on `Contact` |
| — | `isPrivate` | boolean; replaces the Access Level string |

**Person**

| Act! | API |
|---|---|
| First Name | `firstName` |
| Surname | `lastName` |
| Middle Name | `middleName` |
| Name Prefix / Suffix | `namePrefix` / `nameSuffix` |
| Salutation | `salutation` |
| Contact | `fullName` |
| Title | `jobTitle` (picklist Jobtitles) |
| Department | `department` |

**Communication**

| Act! | API |
|---|---|
| E-mail | `emailAddress` |
| E-Mail 2 | `customFields/email_2_email` |
| Phone | `businessPhone` + `businessExtension`, `businessCountryCode`, `businessMaskFormat` |
| Mobile Phone | `mobilePhone` + same satellites |
| Phone 2 | `customFields/phone_2_phone` |
| Fax | `faxPhone` |
| Web Site | `website` |

**Address** — `businessAddress` is an object: `line1`, `line2`, `line3`, `city`, `state`, `postalCode`, `country`, `latitude`, `longitude`. `city`, `state`, `country` carry picklists (Cities, States, Countries). `homeAddress` has the same shape.

**Commercial state**

| Act! | API | Picklist |
|---|---|---|
| ID/Status | `idStatus` | Contact ID/Status |
| **Stage** | **`messengerID`** | Stage |
| Priority | `customFields/priority` | Priority Group |
| Territory | `customFields/territory` | Territory |
| Industry | `customFields/user6` | Industry |
| Interested in | `customFields/user3` | Interested in? |
| Referred By | `referredBy` | Referred By |
| Account Mgr | `customFields/rep` | Rep |
| Owner | `customFields/owner` | — |

**Equipment profile** (read into the snapshot only, no PathQuote UI in v1)

`customFields/user2` = Cutter User · `cutter_2` … `cutter_5` · `cad_2`, `cad_3` · `pf_product_1` … `pf_product_5` · `serial_1` … `serial_5` · `intall_date_1`, `install_date_2` … `install_date_5` · `warranty_1` … `warranty_5`

**Do not touch:** `amaScore`, `aemOptOut`, `aemBounceBack`, `customFields/bounced`, `customFields/email_2_bounced` — these belong to Act! Marketing Automation and Act! Email Marketing.

### Landmines

`Stage` is stored in the stock `messengerID` field, capped at 16 characters. If anyone ever uses Messenger ID for its documented purpose, the two collide.

`Industry` → `user6`, `Cutter User` → `user2`, `Interested in` → `user3` are renamed stock user slots. Remaining free slots: `user_11` … `user_15`, `field`, `model`, `ticker_symbol`, `4th_contact`, `logo`, `logo1`. We do not take any of them; new fields are created explicitly instead.

## 5. Field mapping — Company

The Company entity carries exactly what a quote needs, and needs no new fields.

| Act! | API |
|---|---|
| Company | `name` |
| Address 1/2/3, City, State, Postcode, Country | `address/line1..line3`, `address/city`, `address/state`, `address/postalCode`, `address/country` |
| Billing Address 1/2/3, City, State, Postcode, Country | `billingAddress/*` |
| Shipping Address 1/2/3, City, State, Postcode, Country | `shippingAddress/*` |
| Industry | `industry` (picklist Industry) |
| Territory | `territory` (picklist Territory) |
| Region | `region` |
| ID/Status | `idStatus` |
| Web Site | `website` |
| Phone / Fax / Toll-Free | `phone` / `fax` / `tollFreePhone` — **not read**; a contact owns the phone number |
| — | `id`, `created`, `edited`, `editedBy`, `recordManager`, `recordManagerID`, `isPrivate` |

**126 company records against 17,373 contacts.** The Company entity is barely used; most contacts carry a company name as free text with an empty `companyID`. PathQuote therefore grows it from real work rather than from a migration — see the design document.

## 6. New fields to create

Five, via `POST /api/metadata/contact/fields`. No manual work in the Act! client.

| Field | Type | Length |
|---|---|---|
| `PQ Web Entry ID` | Character | 20 |
| `PQ Lead Score` | Number | — |
| `PQ Enquiry Type` | Character + picklist (`General`, `Machinery Sales`) | 32 |
| `PQ Lead Source` | Character | 100 |
| `PQ Landing Page` | Character | 255 |

## 7. History types

71 defined. The ones that matter:

| Id | Name | Use |
|---|---|---|
| 62 | **Quote** | "A Quote has been produced for an Opportunity" — PathQuote write-back |
| 1 | Call Completed | counts as a human touch |
| 0 | Call Attempted | |
| 2 | Call Received | |
| 17 | Call Left Message | |
| 6 | Meeting Held | counts as a human touch |
| 16 | E-mail Sent | counts as a human touch |
| 8 | To-do Done | |
| 3 | Field Changed | system-generated, never a touch |
| 13 | Contact Updated | system-generated |
| 51 / 52 | Sent Sync / Received Sync | system-generated |

### Distinguishing automatic records from human ones

History written through the API carries the authenticating user. If the integration runs under its own Act! account, a human touch is simply any history record whose creator is **not** that account. No text convention, nothing to remember to set, and it works retroactively.

This is the preferred mechanism. It only holds while the integration has a dedicated account: if it authenticates as a salesperson, automatic and human records become indistinguishable and the response-time metrics lose their meaning.

## 8. Opportunity processes

Two live processes. Stage mapping is therefore **per region**, which lines up with PathQuote's own `Region` model.

**Pathfinder Sales Cycle** — `2380e83d-cef4-4b6d-ad15-dc9a558431ab`

Initial Communication 5% · Needs Assessment 10% · Presentation 20% · Proposal 40% · Negotiation 65% · Verbal Commitment 90% · Sales Fulfillment 100%

**Pathfinder US Sales Process** — `26ab3a1e-ff20-406d-a0b4-3b351955da45`

Assess 20% · Engage 40% · Build Develop 60% · Gain Commitment 80% · Execute Fulfilment 100%

**Previous ACT! Sales Process** — 13 stages, all at 0% probability. Legacy; not used.

A PathQuote quote that has been sent maps to `Proposal` (AU) or `Engage` (US).

## 9. Users

20 Act! users, most with an email address, which is the join key to PathQuote users. Record Manager appears on a contact both as `recordManagerID` (uuid) and `recordManager` (display name); the uuid is the stable one.

## 10. Reading with a delta cursor

The sync is `src/lib/act/sync.ts`, started three ways: `npm run act:sync`, the nightly `pq-act-sync.timer` on the VPS, and the **Sync now** button at `/settings/act-sync`. It is read-only against Act!.

```
GET /api/contacts?$top=200&$skip=0&$orderby=edited&$filter=edited ge 2026-09-01T00:00:00.000Z
```

Pages of 200, oldest `edited` first, advancing `$skip` until a short page — about 88 requests for a full import, measured against the 17,529 contacts the account can see (*What the first full import produced*, below). `syncContacts` is one operation serving all three of those callers, so there is no separate full-import path to drift from the incremental one. See `docs/runbook.md` §4c for the timer, the logs, and the one failure state that needs a person.

### What is filtered where

**The request carries no filter except `edited ge`**, and a `--full` run omits that too. In particular there is no `contactType`, `isPrivate` or `idStatus` clause: every contact the account can see comes back, and the mapper (`src/lib/act/map.ts`) discards what PathQuote must not hold:

- anything whose `contactType` is not `Contact`
- `isPrivate`
- `idStatus` of `Personal` — the director's own contacts, counted separately as `personal`. This check in the mapper is the **only** thing keeping them out, so a non-zero `personal` count is expected
- `idStatus` not in `Customer` or `Prospect` — narrowed from four statuses on 2026-10-08 (see ACTIVE_STATUSES in src/lib/act/types.ts for why). The four-status set kept 12,323 of 17,529 at last measurement; the two-status set is smaller, and the figure is recorded below once the first import runs

The one filtering that does happen server-side is the account's own permissions: without *Access All Non-Private Data* it would see almost nothing (section 2), and private records belonging to others are not returned to it (section 3).

`gt` was verified against the live API (section 3). `ge` is the same operator family and is what the code sends, but it had not yet been exercised against the live system when this was written; the first real run is where that gets confirmed. A server-side status filter would shrink the run from ~17,400 reads to ~12,100, but it has not been tried against the API and is deliberately not there.

### Why `ge` and not `gt`

The cursor is the `edited` of the newest record stored. A `--limit` run stops partway through the oldest-first stream, so another record can share that exact timestamp and never have been reached. `gt` would skip it permanently; `ge` reads the boundary record again, which fill-only-empty turns into a no-op. Do not "tidy" it to `gt`.

### The cursor

| | |
|---|---|
| Stored in | table `Setting`, key `act.sync.cursor` |
| Value | JSON `{"editedAt": "<ISO timestamp>"}` |
| Means | the newest `edited` timestamp **successfully stored** — *not* the time of the last run |
| Written | after every fully processed page, so an interrupted run resumes near where it stopped |
| Never written | by a `--dry-run` |
| Stops advancing | the moment any contact in the run fails. A failed record sits at or after the cursor in oldest-first order, so moving past it would skip it forever; holding the cursor makes the next run try it again |

Inspect it with `SELECT value FROM "Setting" WHERE key = 'act.sync.cursor';`. Deleting the row makes the next run read everything, same as `--full`.

`--full` ignores the stored cursor while reading, but it still checkpoints as it goes, so it overwrites the cursor with wherever that run got to — which, for a `--full --limit N`, is older than before. That is harmless (the next delta run just re-reads more) but it is a rewind, not a no-op.

### Running it

```
npm run act:sync -- --dry-run --limit 50   # read and report, write nothing
npm run act:sync -- --limit 200            # a careful first write
npm run act:sync                           # delta since the stored cursor
npm run act:sync -- --full                 # ignore the cursor, read everything
```

| Flag | Meaning |
|---|---|
| `--dry-run` | Read and map, write nothing — including no cursor. |
| `--limit N` or `--limit=N` | Stop after N contacts. N must be a positive whole number. |
| `--full` | Ignore the stored cursor and read everything. |

Those three are the whole interface. Anything else, a missing `--limit` value, `0`, a negative or a non-number is refused with exit status `2`, before anything is read or written. A banner naming the mode (`dry run` or `WRITE`), the limit and the database (`host:port/name`, never the password) is printed first.

The `--` after the script name is required. Without it npm consumes the flags itself and the script starts with none, which is a full write. The CLI notices that npm swallowed a flag and refuses.

Exit status: `0` clean; `1` the run threw (for example an unrecognised response shape from the API) or one or more contacts failed to store; `2` bad arguments, or no database could be identified from `DATABASE_URL`.

The report prints `company key collisions` and `failed`. A non-zero collision count means two different Act! companies have names that normalise to the same key, so two firms may be sharing a name: a person needs to look. A non-zero `failed` count comes with the first failing contact id and its error.

### Configuration

Read from the environment (`.env` is loaded by `dotenv/config`, and `docker compose` passes it to the `tools` container):

| Variable | Value |
|---|---|
| `ACT_BASE` | `https://actapi.pathfindercut.com/act.web.api` |
| `ACT_DB` | `Pathfinder` |
| `ACT_USER` | the Act! **display name** as it appears in Manage Users, e.g. `John Hollo`, not `john`. The integration account is `Marketing` (section 2) |
| `ACT_PASS` | that account's password |

A missing variable is reported by name. A wrong `ACT_USER` or `ACT_DB` is not: both return a bare `401` (section 2). The sync also reads and writes `DATABASE_URL`, like the rest of PathQuote.

### Where it has to run

The API is IP-allowlisted to the VPS (`74.208.106.34`, section 11). Any other address, a laptop included, gets `403` however correct the credentials. The sync therefore runs on the VPS, not from a development machine.

### Transport

Each request has a 30 second timeout. A network error, a timeout or a `5xx` is retried, three attempts in all with a 1 s then 2 s pause, and each retry is logged. A `4xx` is a real answer and is not retried. A `401` triggers one re-authorisation, which is separate from the retries.

A response that is neither an array nor an object with an array `value` is an error, not an empty page. It names the shape it saw. Treating it as empty would have made a changed envelope look like a successful run with nothing to do.

### What the first full import produced

Production, 2026-10-08. A baseline: without one, "is 865 unresolved phones a
problem?" has no answer. Compare a later run against this before concluding
anything has gone wrong.

| | |
|---|---|
| scanned | 17,529 |
| contacts created | 10,399 |
| contacts updated | 72 |
| companies created | 8,735 |
| companies with no contact | 536 |
| phones unresolved | 865 |
| company key collisions | 0 |
| failed | 0 |
| skipped: inactive-status | 6,320 |
| skipped: personal | 175 |
| skipped: not-a-contact | 23 |
| skipped: no-company | 4 |

Afterwards, in the database: 8,809 companies carrying `actSyncedAt`, of which
130 have no country; 10,471 contacts with an `actContactId`; 485 companies with
no contact at all; 0 `ActSnapshot` rows with the wrong number of owners.
`actStatus` is `Prospect` on 8,122 and `Customer` on 687, and nothing else —
the two-status filter, confirmed in the data rather than in the log.

Two numbers that look wrong and are not:

**`contacts updated` 72 on a first import.** 10,399 + 72 = 10,471, and the
database holds 10,471, so nothing was missed: 72 contacts were returned twice
within the one run. The country-correction script had set ~271 records to the
same `edited` timestamp minutes earlier, and `$skip` paging over a cluster of
identical sort keys has no stable order between pages. Harmless, because
fill-only-empty makes the second pass a no-op — but it is the `$skip`
instability made visible, and the mitigation is the periodic `--full` that
re-reads everything.

**`companies created` 8,735 against 8,809 in the table.** The difference is 74:
the 2 companies the preflight had already keyed, plus the 72 above, whose
companies were matched rather than created on the second pass.

## 11. Infrastructure

**Working end to end as of 2026-10-06.** Verified from the VPS: `GET /act.web.api/` returns `200` and `/authorize` returns a token, over HTTPS on the public hostname.

**Base URL:** `https://actapi.pathfindercut.com/act.web.api`

### Topology

```
            VPS 74.208.106.34                    everyone else
            PathQuote, n8n, website                    |
                        |                              |
                        v                              v
            180.181.193.49  one public IP, NAT on the office router
                        |                              |
            source-IP NAT rule                    default path
            (higher priority)                          |
                        |                              v
                        |                   172.25.1.11  IIS + ARR reverse proxy
                        |                              |
                        +--------------+---------------+
                                       v
                            172.25.1.13  Act! server
                            IIS, Act! Web API, Act! sync
```

`act.pathfinderaus.com.au`, `remote.pathfinderaus.com.au` and `actapi.pathfindercut.com` all resolve to `180.181.193.49`. Internally, split-horizon DNS resolves `remote.` to `172.25.1.11` and `act.` to `172.25.1.13`.

The provider solved the routing with a **source-IP NAT rule rather than a proxy entry**: traffic arriving from `74.208.106.34` on 443 is sent straight to the Act! server, bypassing the ARR proxy entirely. Everyone else still lands on the proxy, where `/act.web.api` does not exist.

That turned out better than the reverse-proxy rule originally requested. TLS is not re-originated, so the Act! server sees the real client address and the existing `ipSecurity` rule works unchanged. The `172.25.1.11` entry in that rule is now redundant but harmless.

The Act! server cannot reach the proxy at all — no route between the segments. That isolation is deliberate and is why every inbound path had to go through the provider.

Outbound from the Act! server works and NATs to the same `180.181.193.49`.

### Access control

| | |
|---|---|
| IIS role | `Web-IP-Security` installed 2026-10-06 |
| Scope | `ipSecurity` on the `act.web.api` application, `allowUnlisted=false` |
| Allowed | `74.208.106.34` (VPS), `172.25.1.11` (proxy, now redundant), `127.0.0.1`, `::1` |

Rules live in `applicationHost.config` under a `<location>` tag, not in the application's own `web.config`, so an Act! upgrade cannot overwrite them and the configuration section stays locked for every other site on the server.

Verified: a request from an unlisted address returns `403`; `localhost` returns `200`.

### Certificates

Two certificates coexist on port 443, and neither depends on the other.

| Binding | Certificate | Owner |
|---|---|---|
| `actapi.pathfindercut.com:443` (SNI) | `CN=actapi.pathfindercut.com`, `838B0E…BA30BC5` | ours, Let's Encrypt via certbot on the VPS |
| `0.0.0.0:443` (catch-all) | `CN=*.pathfindercut.com`, `ED3679…D725A7CC` | the provider's |

A hostname-specific SNI binding wins over the catch-all, so the integration uses ours and everything else — Act! sync included — continues on theirs. **The catch-all binding is never touched**; every manager's laptop syncs through it.

The wildcard appeared when the provider set up the NAT rule: they issued it and replaced the server's certificate store in the process, removing both the certificate we had installed and the long-expired `act.pathfinderaus.com.au` one. A wildcard for this domain can only come from DNS-01 validation on a zone we manage, so where that validation runs is worth asking them — whoever holds that key can impersonate any host under the domain, PathQuote at `q.pathfindercut.com` included.

Rebinding ours removed the dependency either way. Renewal is automated end to end, because the Act! server is LAN-only: nobody outside the office can renew it by hand, so leaving it manual would mean the integration dies the first time one person is on leave. Certbot renews on the VPS, a deploy hook publishes the PFX, and a weekly scheduled task on the Act! server fetches it over an outbound connection and rebinds only when the thumbprint has changed.

Setup, operation and failure modes: `scripts/act-cert/README.md`. The warning that matters is Application event `9002` on the Act! server — fewer than 21 days left and the published copy has not been renewed. The sync worker logs observed expiry as well, so the warning arrives by two independent paths.


### Why Tailscale was removed

An overlay was built and verified working on 2026-10-05, then removed the next day because it broke the Aussie Time Sheets system on the same server.

The cause, per the provider, was not DNS as first assumed: the virtual adapter came up with a **lower interface metric**, which stopped local devices seeing broadcast traffic from the server, so the discovery protocols that time clocks and client devices rely on stopped finding it. `--accept-dns=false` would not have fixed that; it would have needed the interface metric adjusted.

Their position that no VPN client goes on that server is sound, and the NAT rule they built instead is a better answer anyway.

### Fallback, if the NAT rule is ever withdrawn

Invert the direction. Outbound from the Act! server works without any perimeter change, so a scheduled task running a PowerShell script could read the API over `localhost` and push to PathQuote.

No installed software, no VPN, no firewall change — but three real costs. The "Sync now" button stops being immediate, because PathQuote cannot reach in to trigger anything: it would set a flag the script polls, making a manual sync take up to a minute instead of a second. The n8n write path breaks the same way and would need the script to pull a job queue and execute it locally. And our code would live on a server the provider maintains, which they may object to on the same grounds as the VPN.

Recorded in case it is needed; not the current design.


## 12. Source files

Captured from the live system, in `RAW/ACT/`:

`swagger.json` — the full API description, 231 paths · `meta/fields_contact.json` — 118 contact fields · `meta/fields_company.json` — 40 company fields · `meta/history_types.json` — 71 types · `meta/opp_processes.json`, `meta/opp_stages.json` · `meta/users.json` · `meta/entities.json`
