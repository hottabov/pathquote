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

### Private network

The API must not be exposed to the internet. The server already publishes `act.pathfinderaus.com.au` for Act! sync; nothing new is added to that surface.

A Tailscale overlay joins the Act! server and the VPS that runs PathQuote and n8n. No firewall rules, no port forwarding, works through NAT.

**On the Act! server**

1. Install the Tailscale Windows package.
2. `tailscale up --unattended` — the `--unattended` flag is required, otherwise the connection drops when no user is logged in.
3. Note the assigned `100.x.y.z` address and the MagicDNS name, `<machine>.<tailnet>.ts.net`.

**On the VPS**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

**Access control** — in the Tailscale admin console, restrict the policy so the VPS can reach the Act! server on port 443 only, and nothing else reaches it at all.

### HTTPS

Tailscale issues real Let's Encrypt certificates for MagicDNS names, so no self-signed certificate and no internal CA is needed.

```powershell
tailscale cert <machine>.<tailnet>.ts.net
```

This writes a `.crt` and a `.key`. Convert to PFX for IIS:

```powershell
openssl pkcs12 -export -out act.pfx -inkey <name>.key -in <name>.crt
```

Import into the Windows certificate store (Local Computer → Personal), then add an IIS https binding on port 443 for the Tailscale address, with **Require Server Name Indication** enabled — port 443 is already in use by the Act! sync site, and SNI is what lets both coexist.

Certificates last 90 days. Schedule the renewal; a quarterly outage of the integration because a certificate quietly expired is the classic failure here.

### Credentials

The API username and password live in configuration, never in code, so the service account can be swapped without a deployment. Separate credentials for PathQuote and n8n if the API ever supports more than one account.

## 12. Source files

Captured from the live system, in `RAW/ACT/`:

`swagger.json` — the full API description, 231 paths · `meta/fields_contact.json` — 118 contact fields · `meta/fields_company.json` — 40 company fields · `meta/history_types.json` — 71 types · `meta/opp_processes.json`, `meta/opp_stages.json` · `meta/users.json` · `meta/entities.json`
