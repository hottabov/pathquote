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

```
GET /api/contacts?$filter=edited gt 2026-09-01T00:00:00Z&$orderby=edited&$top=200
```

Verified working. The same call serves both the nightly job and the manual "Load contacts" button, with the cursor being the timestamp of the last successful run.

Filters applied by the client:

- `contactType eq 'Contact'`
- not `isPrivate`, unless the caller is that record's Record Manager
- `idStatus` in `Customer`, `Prospect`, `Prospect-Distributor`, `Suspect` — about 12,094 of 17,373

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

The endpoint presents a wildcard `*.pathfindercut.com`, thumbprint `ED3679726AB41E7986BAC3D7BB2A024ED725A7CC`, expiring 4 January 2027. The provider issued it and replaced the server's certificate store and bindings in the process — the `actapi.pathfindercut.com` certificate we had installed, and the expired `act.pathfinderaus.com.au` one, are both gone.

A wildcard for this domain can only have been issued through DNS-01 validation on `pathfindercut.com`, whose DNS we manage. Where that validation runs is an open question with the provider, along with whether renewal is automated. Whoever holds the key can impersonate any host under the domain, including PathQuote itself at `q.pathfindercut.com`, so it is worth knowing.

Our own `actapi.pathfindercut.com` certificate is kept on the VPS and renewed by certbot even though it is currently unused. If the provider's wildcard ever lapses, rebinding ours takes minutes. The deploy hook that rebuilds the PFX on renewal is worth keeping in place for the same reason.

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
