# ACT! Integration — Field Specification

**Pathfinder — PathQuote project · 9 September 2026 · v2.0**

---

## 1. What we are building

```
website form  →  n8n  →  ACT!  →  PathQuote  →  ACT!
```

A sales enquiry submitted on pathfindercut.com is processed by n8n and written into ACT! as a contact, with a history record and a follow-up activity.

PathQuote, our quotation application, reads contacts and companies out of ACT! into a local cache so a salesperson can find a client and issue a quote. It writes back: new contacts and companies it creates, edits to the fields listed in section 6 and 7, a history record when a quote is sent, and an opportunity.

ACT! is the system of record. PathQuote is a cache plus a quoting tool.

## 2. What we need from you

**Read access** to the fields in sections 3 and 4, filtered and paged, with a modified-since cursor.

**Write access** to the fields in sections 6 to 10.

You decide the mechanism. Two callers will use it: n8n and PathQuote, from a server that reaches the ACT! machine over VPN.

---

## 3. Read — Contact

23 fields.

| Group | Fields |
|---|---|
| Keys | `CONTACTID`, `COMPANYID`, `EDITDATE`, `CREATEDATE` |
| Person | `First Name`, `Surname`, `Title` |
| Contact details | `E-mail`, `Phone`, `Mobile Phone` |
| Company and address | `Company`, `Address 1`, `Address 2`, `City`, `State`, `Postcode`, `Country`, `Web Site` |
| Classification | `Industry`, `Territory`, `Record Manager`, `Access Level`, `ID/Status` |

Filters to apply:

- `Contact Type = 'Contact'`
- exclude `Access Level = 'Private'`, unless the caller is that record's Record Manager
- `ID/Status IN ('Customer', 'Prospect', 'Prospect-Distributor', 'Suspect')`

Parameters we need to pass: modified-since timestamp, Record Manager (optional — when absent, return all non-private records), page size, page cursor.

Ordering: `EDITDATE` ascending, then `CONTACTID`.

## 4. Read — Company

29 fields.

| Group | Fields |
|---|---|
| Keys | `COMPANYID`, `EDITDATE`, `CREATEDATE` |
| Name | `Company` |
| Main address | `Address 1`, `Address 2`, `Address 3`, `City`, `State`, `Postcode`, `Country` |
| Billing address | `Billing Address 1`, `Billing Address 2`, `Billing City`, `Billing State`, `Billing Postcode`, `Billing Country` |
| Shipping address | `Shipping Address 1`, `Shipping Address 2`, `Shipping City`, `Shipping State`, `Shipping Postcode`, `Shipping Country` |
| Other | `Web Site`, `Industry`, `Territory`, `Record Manager`, `Access Level`, `ID/Status` |

Same parameters and ordering as section 3.

## 5. Read — History and Activity

| Entity | Fields |
|---|---|
| History | `HISTORYID`, `CONTACTID`, `COMPANYID`, history type, `Regarding`, date, `Record Manager`, created-by user |
| Activity | `ACTIVITYID`, `CONTACTID`, activity type, date, scheduled-for user, cleared/completed flag |

Parameters: date range, page size, page cursor.

---

## 6. Write — new fields to create in ACT!

Five new contact fields. We ask for the `PQ ` prefix so their origin stays clear.

| Field | Type | Size | Indexed |
|---|---|---|---|
| `PQ Web Entry ID` | Character | 20 | yes |
| `PQ Lead Score` | Number, 1 decimal | — | yes |
| `PQ Enquiry Type` | Dropdown: `General`, `Machinery Sales` | — | no |
| `PQ Lead Source` | Character | 100 | no |
| `PQ Landing Page` | Character | 255 | no |

Do not repurpose `AMA Score`, `AEM Opt Out`, `AEM Bounce Back`, `Bounced`, or `Email 2 Bounced` for these. Nothing in this integration reads or writes those fields.

## 7. Write — Contact

Create and update.

| Group | Fields |
|---|---|
| Person | `First Name`, `Surname`, `Title` |
| Contact details | `E-mail`, `Phone` |
| Company and address | `Company`, `Address 1`, `Address 2`, `City`, `State`, `Postcode`, `Country` |
| Classification | `Industry`, `Territory`, `Interested in`, `Cutter User`, `Priority` |
| On create only | `Record Manager`, `Access Level`, `ID/Status`, `Referred By` |
| PQ fields | `PQ Web Entry ID`, `PQ Lead Score`, `PQ Enquiry Type`, `PQ Lead Source`, `PQ Landing Page` |

Rules:

- Existing non-empty values are not overwritten, except for the five `PQ ` fields, which always take the latest value.
- `Record Manager` is set on create and never changed afterwards.
- We send back the `EDITDATE` we last read. If it no longer matches the record's current `EDITDATE`, reject the write and return the current values.
- No delete operation is required. We will never delete a contact.

Deduplication before create: match on `E-mail`, then on phone. Do not create a second contact for a person who already exists.

## 8. Write — Company

Create and update, plus linking a contact to a company.

| Group | Fields |
|---|---|
| Name | `Company` |
| Main address | `Address 1`, `Address 2`, `City`, `State`, `Postcode`, `Country` |
| Billing address | `Billing Address 1`, `Billing Address 2`, `Billing City`, `Billing State`, `Billing Postcode`, `Billing Country` |
| Shipping address | `Shipping Address 1`, `Shipping Address 2`, `Shipping City`, `Shipping State`, `Shipping Postcode`, `Shipping Country` |
| Other | `Web Site`, `Industry`, `Territory` |
| On create only | `Record Manager`, `Access Level`, `ID/Status` |

Same rules as section 7. No delete operation is required.

## 9. Write — History

| Attribute | Value |
|---|---|
| Type | `Other` |
| Regarding | free text, supplied by us |
| Date | supplied by us, not the write timestamp |
| Details | free text, supplied by us; several thousand characters |
| Linked contact | by `CONTACTID` |
| Record Manager | supplied by us |

**Records written automatically must be distinguishable from records created by a person.** Either a dedicated history type, or our `Regarding` text always beginning with `[AUTO]` — whichever you prefer, but it has to be reliable and it has to be in place from the first record written.

## 10. Write — Activity and Opportunity

| Entity | Fields |
|---|---|
| Activity | type `Call`, date, assigned user, subject, priority, alarm |
| Opportunity | name, linked contact, linked company, amount, currency, estimated close date, probability, stage, product lines as name / quantity / price |

Opportunity product lines are free text. Do not link them to the ACT! product catalogue.

---

## 11. Information we need back

1. The list of Opportunity processes and their stages, as configured in this database.
2. The list of history types, as configured in this database.
3. The ACT! user list: login name, display name, email.
4. Whether any remote ACT! databases synchronise with the main database.

---

## 12. Not in scope

- Deleting contacts, companies, history, activities, or opportunities.
- Any read or write of Act! Marketing Automation or Act! Email Marketing fields.
- Cleanup or migration of existing data.
- Linking opportunity products to the ACT! product catalogue.
