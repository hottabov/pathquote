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

Built and verified 2026-10-05.

**Base URL for the integration:** `https://pf-sql.tail01aa0f.ts.net/act.web.api`

### Private network

The API is not exposed to the internet. The server already publishes `act.pathfinderaus.com.au` for Act! sync; nothing was added to that surface.

A Tailscale overlay joins the two machines:

| Machine | Tailscale address | Role |
|---|---|---|
| `pf-sql` | `100.97.78.35` | Windows Server 2019, ACT! and IIS |
| `ubuntu` | `100.76.123.107` | VPS running PathQuote and n8n |

Tailnet: `tail01aa0f.ts.net`.

**Windows server.** Install the package, then `tailscale up --unattended` — without `--unattended` the connection drops as soon as nobody is logged in, and the nightly sync fails silently.

Two traps on Windows. The CLI is not added to `PATH`: it lives at `C:\Program Files\Tailscale\tailscale.exe`. And the local API is bound to the user running the GUI, so the CLI must run in a **non-elevated** shell as that user — an elevated prompt gets `401 Unauthorized: Tailscale already in use`.

Browser sign-in on Windows Server tends to fail against Google. Use a pre-authorised key from the admin console instead: `tailscale up --unattended --authkey=tskey-auth-…`.

**VPS.** `curl -fsSL https://tailscale.com/install.sh | sh`, then `tailscale up`.

### DNS

MagicDNS does not work on this VPS. `systemd-resolved` reports the interface as managed by something else, and Tailscale's health check says so plainly: `setLinkDNS: Link tailscale0 is managed`.

Rather than fight it, the single hostname is pinned:

```bash
echo "100.97.78.35 pf-sql.tail01aa0f.ts.net" | sudo tee -a /etc/hosts
sudo tailscale up --accept-dns=false
```

Tailscale addresses are stable for the life of the node, and `--accept-dns=false` stops it retrying something this system will not allow, which also clears the health warning. The hostname still matters — it is what the certificate is issued for.

### HTTPS

Tailscale issues real Let's Encrypt certificates for MagicDNS names, so there is no self-signed certificate and no internal CA. MagicDNS and HTTPS Certificates must both be enabled in the admin console first.

```powershell
tailscale cert pf-sql.tail01aa0f.ts.net          # non-elevated, as the GUI user
openssl pkcs12 -export -out act.pfx -inkey pf-sql.…key -in pf-sql.…crt
```

Then, **elevated**:

```powershell
$cert = Import-PfxCertificate -FilePath C:\Temp\act.pfx `
  -CertStoreLocation Cert:\LocalMachine\My -Password $pw
New-WebBinding -Name "Default Web Site" -Protocol https -Port 443 `
  -HostHeader "pf-sql.tail01aa0f.ts.net" -SslFlags 1
Get-Item "Cert:\LocalMachine\My\$($cert.Thumbprint)" |
  New-Item -Path "IIS:\SslBindings\!443!pf-sql.tail01aa0f.ts.net" -SSLFlags 1
```

`SslFlags 1` is SNI, and it is not optional: port 443 already belongs to the Act! sync site, and SNI is what lets the two bindings coexist.

Current certificate thumbprint: `84C71E6B7F4503A3D2491D019597054580542079`.

Delete `act.pfx`, the `.key` and the `.crt` afterwards. The private key is in the Windows store; a plaintext copy in `C:\Temp` is risk without benefit.

**Certificates last 90 days.** Schedule the renewal. An integration that quietly dies once a quarter because a certificate expired is the classic failure of this design.

### Access control

Once HTTPS is confirmed, narrow the Tailscale policy so the VPS reaches only what it needs:

```json
{
  "acls": [
    { "action": "accept", "src": ["100.76.123.107"], "dst": ["100.97.78.35:443"] }
  ]
}
```

Add a rule for the administrator's own machine covering 443 and 3389 before applying this, and confirm RDP still works before closing the session.

### Credentials

The API username and password live in configuration, never in code, so the service account can be swapped without a deployment. Separate credentials for PathQuote and n8n if the API ever supports more than one account.

## 12. Source files

Captured from the live system, in `RAW/ACT/`:

`swagger.json` — the full API description, 231 paths · `meta/fields_contact.json` — 118 contact fields · `meta/fields_company.json` — 40 company fields · `meta/history_types.json` — 71 types · `meta/opp_processes.json`, `meta/opp_stages.json` · `meta/users.json` · `meta/entities.json`
