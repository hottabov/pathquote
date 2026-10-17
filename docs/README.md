# PathQuote documentation

What is here, and when to read it. Everything else that used to live under
`docs/` — completed implementation plans, pre-build analyses of the price
lists and templates, builder mock-ups, draft copy — was removed on 2026-10-17
and remains in git history (`git log --all -- 'docs/**'`).

| Read | When |
|---|---|
| [runbook.md](runbook.md) | Operating production: VPS setup, deploy, backups, ACT! sync/drain units, nginx, restore, rollback. |
| [act-integration-reference.md](act-integration-reference.md) | How ACT!'s API behaves as probed live — field names, envelopes, paging, quirks the code works around. |
| [technical-audit/](technical-audit/README.md) | The 2026-10 performance and architecture audit: findings, measurements, production evidence, what was changed and why. |
| [design/](design/) | Design decisions behind live behaviour, dated. The code comments cite these by path. Newest wins where two overlap. |
| [reference/](reference/) | Rules and how-tos that stay true: client ownership and regional scope, catalogue import/export, catalogue v2 decisions (source of `catalog-v2-target.json`), email sending setup. |
| [backlog/](backlog/) | Work not done, with the reasoning kept so it is not re-derived: quote outcomes and reporting; order-form details still off the paper (and the production-manager conversation they came from); the unported findings of the abandoned `audit/modernization` branch. |

Conventions: a design document records a decision and its date; when the
code moves on, the document is amended or replaced, not left to drift. A plan
(step-by-step implementation notes) is deleted once shipped — the commits are
the record.
