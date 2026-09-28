<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Security skills

818 cybersecurity skills (agentskills.io standard, Apache-2.0) vendored at
`skills/<skill-name>/SKILL.md` — source: https://github.com/mukul975/anthropic-cybersecurity-skills

Before any security-related task (pentest, forensics, threat hunting, IR,
cloud/AD hardening, malware analysis, etc.), scan `skills/` for a matching
`SKILL.md` (frontmatter has `name`, `description`, `tags`) and follow its
Workflow/Verification steps. Claude Code also sees these via `.claude/skills/*`
symlinks into this same directory — one copy, two entry points.

# Production is live (since 2026-09-28)

Production (`/opt/pathquote` on the VPS, see docs/runbook.md) holds real
quotes, users and clients. Treat its database as irreplaceable:

- Never drop, restore over, or purge the production database. There is no
  "copy local to prod" step any more; `replace-prod-with-local.sh` is gone.
- Catalogue changes ship as idempotent migrations keyed by code. Retire a
  product or option with `active = false`, not `DELETE`.
- No migration may delete or rewrite existing `Document` rows (quotes,
  items, lines, revisions, signing requests) without an explicit decision
  from Vadym and a backup taken first.
- Images reach production with `scripts/push-images-to-prod.sh` (additive,
  images only, never the database).
- `npm run quotes:purge` is for a local database only and refuses anything
  that is not localhost.
