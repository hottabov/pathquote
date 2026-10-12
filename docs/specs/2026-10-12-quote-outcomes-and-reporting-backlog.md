# Backlog: quote outcomes, and reporting on them

**Status:** backlog. Not in the current pass. Recorded 2026-10-12 so the reasoning is not re-derived later.

**Why it exists:** Vadym wants to see how many quotes went out and how many were won, by period, so the business can read its own state. Nothing in PathQuote can answer that today, and the reason is not a missing chart — it is a missing fact.

---

## 1. Nothing knows whether a quote was won

`acceptedAt` / `acceptedById` are set by `acceptQuote` (`src/lib/actions/finalize.ts:678-718`), but **only when the client signs through PathQuote**. A manager who downloads the PDF, emails it, and gets a purchase order back by reply leaves no trace in PathQuote at all — and that is a normal way to work here, which is also why `Finalize` rather than `SENT` is the ACT! write-back trigger (see `docs/superpowers/specs/2026-10-10-act-write-back.md` §10a).

So **somebody has to mark it.** There is no way around that: the win happens outside the software. The only real questions are how cheap the marking is and what makes anyone do it.

## 2. The shape

**An outcome axis on the quote**, separate from `DocumentStatus` and `SigningStatus`: `PENDING | WON | LOST`, with a date, the user who decided, and a reason for a loss. A quote that reached FINAL has been quoted; its outcome is a different question from its signing state.

Two ways it gets set:

- **Automatically** when the client signs through PathQuote — `acceptQuote` already does exactly this, so that path costs nothing.
- **By hand** when the signature happened outside the system.

**What makes managers mark it: a short "awaiting outcome" list** — finalised quotes past their validity with no outcome recorded. `Document.validityDays` and `issueDate` already exist on every quote, so the expiry needs no new data. A list of five rows that a manager clears in a minute works better than any reminder, because it shames itself. A reminder emailed to someone is ignored; a list with their name on it is not.

Do **not** build a nag email, a deadline, or an escalation. The list is the mechanism.

## 3. The reporting, per role

Three audiences, three scopes. The scope rule already exists — `companyWhereForUser` / `documentWhereForUser` in `src/lib/scope.ts` — so reporting must go through it rather than inventing a second answer to "whose quotes are these".

- **Manager** — their own quotes: quoted, sent, won, lost, win rate, and what is awaiting an outcome.
- **Regional manager** — the same for their region, plus a comparison between the managers in it.
- **Admin / developer** — everything, plus by region and by manager.

Metrics worth having, all computable from data that exists once §2 lands: quotes finalised per period, sent per period, won, lost, win rate, average time from finalise to outcome, and value.

## 4. Currency is the trap

`Document.currency` is snapshotted per region — AUD, USD, GBP — and **there is no FX anywhere in the schema**.

So a value chart cannot sum across regions. Either one series per currency, or the chart is scoped to a region. Inventing a conversion rate would be worse than refusing to sum, because it would be wrong silently and nobody would know which number to trust.

If a single cross-region figure is ever genuinely wanted, that needs a stored rate per period and a decision about which rate — a project of its own, not a formatting choice.

## 5. Order

§2 before §3. The outcome field is the prerequisite: without it every chart would plot `acceptedAt`, which measures "signed through PathQuote" rather than "won", and would under-report the business by however much of it goes out as emailed PDFs.

## 6. Relation to the ACT! write-back

`docs/superpowers/specs/2026-10-10-act-write-back.md` maps an accepted quote onto the 100% stage of its region's sales process (§10 D3). Won/Lost in ACT! lives on the Opportunity's **status** (Open / Closed-Won / Closed-Lost), which is a separate field from the stage — to be confirmed against `RAW/ACT/swagger.json` before that is built.

That write-back is only as good as the outcome data behind it. Until §2 exists, ACT! can learn that a quote was signed in PathQuote and nothing else, so an opportunity won by email stays Open in the CRM forever.
