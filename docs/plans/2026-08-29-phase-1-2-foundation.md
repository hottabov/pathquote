# PathQuote Phase 1-2: Foundation Implementation Plan

> **Historical (2026-09-06).** The Excel → JSON extractors this plan creates
> (`scripts/extract-catalog.ts`, `scripts/extract-us-prices.ts` and their `npm run
> extract:*` entries) were deleted with the old code contract; `prisma/seed-data/*.json`
> is now written by `npm run catalog:build-seed-data` from
> `docs/reference/catalog-v2-target.json` (see
> `docs/plans/2026-09-05-catalog-identity-and-cleanup.md`). Everything else below is the
> record of what was built.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Running PathQuote skeleton on q.pathfindercut.com: login (email+password, magic link), full DB schema, catalog seeded from the Excel price list, CI auto-deploy.

**Architecture:** Next.js App Router monolith; Prisma + PostgreSQL; Auth.js v5 (JWT sessions, Prisma adapter for magic-link tokens); Docker Compose (`app`, `postgres`, `gotenberg`) behind existing Nginx; Excel → committed JSON → seed pipeline.

**Tech Stack:** Next.js 15 (TypeScript), Tailwind CSS 4, shadcn/ui, Prisma 6, next-auth@5 (beta), @node-rs/argon2, nodemailer, xlsx (SheetJS), Vitest.

**Repo:** https://github.com/hottabov/pf-invoice — the app lives at repo root alongside `RAW/` and `docs/`.

---

### Task 1: Scaffold Next.js app

**Files:**
- Create: Next.js project at repo root (`package.json`, `src/app/*`, configs)
- Modify: `.gitignore`

- [ ] **Step 1: Scaffold into the existing repo**

```bash
cd <repo-root>
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack
```

If it refuses because the directory is non-empty, scaffold into `/tmp/pq` and copy everything except `.git`, `README.md` into repo root.

- [ ] **Step 2: Install dependencies**

```bash
npm i prisma @prisma/client next-auth@beta @auth/prisma-adapter @node-rs/argon2 nodemailer zod
npm i -D vitest @types/nodemailer xlsx tsx
npx shadcn@latest init -d
```

- [ ] **Step 3: Add npm scripts to `package.json`**

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "typecheck": "tsc --noEmit",
  "test": "vitest run",
  "extract:catalog": "tsx scripts/extract-catalog.ts",
  "db:migrate": "prisma migrate deploy",
  "db:seed": "tsx prisma/seed.ts"
}
```

- [ ] **Step 4: Ensure `.gitignore` covers** `.env`, `node_modules`, `.next`, `/data`

- [ ] **Step 5: Verify dev server boots**

Run: `npm run dev` → 200 on http://localhost:3000. Stop it.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold Next.js app with Tailwind, shadcn, deps"
```

---

### Task 2: Brand theme tokens

**Files:**
- Modify: `src/app/globals.css`

- [ ] **Step 1: Add brand palette to Tailwind 4 theme in `globals.css`**

```css
@theme {
  --color-brand: #243478;        /* PMS 287 */
  --color-brand-accent: #00b8e2; /* PMS 306 */
  --color-brand-dark: #2b304f;   /* PMS 533 */
}
```

- [ ] **Step 2: Set base font stack** (approximation of Myriad Pro):

```css
body { font-family: "Segoe UI", "Source Sans 3", system-ui, sans-serif; }
```

- [ ] **Step 3: Commit** `git commit -am "feat: brand theme tokens"`

---

### Task 3: Docker Compose + Dockerfile

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.env.example`, `.dockerignore`

- [ ] **Step 1: `next.config.ts` — enable standalone output**

```ts
const nextConfig = { output: "standalone" };
export default nextConfig;
```

- [ ] **Step 2: `Dockerfile`**

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 3: `docker-compose.yml`**

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:3010:3000"
    env_file: .env
    depends_on: [postgres, gotenberg]
    volumes:
      - uploads:/data/uploads
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: pathquote
      POSTGRES_USER: pathquote
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
  gotenberg:
    image: gotenberg/gotenberg:8
    restart: unless-stopped
volumes:
  pgdata:
  uploads:
```

- [ ] **Step 4: `.env.example`**

```bash
DATABASE_URL=postgresql://pathquote:CHANGE_ME@postgres:5432/pathquote
POSTGRES_PASSWORD=CHANGE_ME
AUTH_SECRET=CHANGE_ME_openssl_rand_base64_32
AUTH_URL=https://q.pathfindercut.com
AUTH_TRUST_HOST=true
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
EMAIL_FROM="PathQuote <noreply@pathfindercut.com>"
GOTENBERG_URL=http://gotenberg:3000
UPLOADS_DIR=/data/uploads
```

- [ ] **Step 5: `.dockerignore`**: `.git`, `node_modules`, `.next`, `RAW`, `docs`, `.env`

- [ ] **Step 6: Verify** `docker compose config` parses. Commit: `git commit -am "feat: docker compose (app, postgres, gotenberg)"`

---

### Task 4: Prisma schema + migration

**Files:**
- Create: `prisma/schema.prisma`, `src/lib/db.ts`

- [ ] **Step 1: Full schema — `prisma/schema.prisma`**

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum Role { ADMIN MANAGER }
enum DocumentType { QUOTE INVOICE }
enum DocumentStatus { DRAFT FINAL }
enum LineKind { OPTION PRODUCT CUSTOM }

model Region {
  id            String   @id @default(cuid())
  code          String   @unique            // AU, US, UK
  name          String
  currency      String                       // AUD, USD, GBP
  taxName       String                       // GST, Sales Tax, VAT
  taxRate       Decimal  @db.Decimal(5, 2)   // 10.00
  entityName    String                       // Pathfinder Australia Pty Ltd
  entityLegalId String?                      // ABN 64 072 458 667
  entityAddress String?
  bankDetails   Json?
  logoUrl       String?
  footerText    String?
  active        Boolean  @default(true)
  users         User[]
  companies     Company[]
  prices        Price[]
  documents     Document[]
  contentBlocks ContentBlock[]
}

model User {
  id            String    @id @default(cuid())
  email         String    @unique
  emailVerified DateTime?
  name          String?
  image         String?
  passwordHash  String?
  role          Role      @default(MANAGER)
  regionId      String?
  region        Region?   @relation(fields: [regionId], references: [id])
  active        Boolean   @default(true)
  documents     Document[]
  accounts      Account[]
  sessions      Session[]
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String?
  access_token      String?
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String?
  session_state     String?
  user              User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime
  @@unique([identifier, token])
}

model Series {
  id             String    @id @default(cuid())
  code           String    @unique          // M, XC, L, P, SW, LNS, EL, EF, FP
  name           String                      // M-Series, X-Calibre...
  maxDiscountPct Decimal?  @db.Decimal(5, 2) // L-Series: 10
  sortOrder      Int       @default(0)
  products       Product[]
  compat         OptionCompatibility[]
}

model Product {
  id          String  @id @default(cuid())
  code        String  @unique               // M5180
  seriesId    String
  series      Series  @relation(fields: [seriesId], references: [id])
  name        String
  description String?
  specs       Json?                          // { cutHeightCm, widthCm, ... }
  imageUrl    String?
  active      Boolean @default(true)
  sortOrder   Int     @default(0)
  prices      Price[]
  compat      OptionCompatibility[]
  docItems    DocumentItem[]
}

model Option {
  id               String  @id @default(cuid())
  code             String  @unique          // MTS, HFV, VRB-180...
  name             String
  shortDescription String?
  attributeSchema  Json?                    // e.g. [{key:"metres",label:"Travel (m)",type:"number"}]
  imageUrl         String?
  active           Boolean @default(true)
  sortOrder        Int     @default(0)
  prices           Price[]
  compat           OptionCompatibility[]
}

model OptionCompatibility {
  id        String   @id @default(cuid())
  optionId  String
  option    Option   @relation(fields: [optionId], references: [id], onDelete: Cascade)
  seriesId  String?                          // compatible with whole series
  series    Series?  @relation(fields: [seriesId], references: [id])
  productId String?                          // or a specific product
  product   Product? @relation(fields: [productId], references: [id])
  @@unique([optionId, seriesId, productId])
}

model Price {
  id        String   @id @default(cuid())
  regionId  String
  region    Region   @relation(fields: [regionId], references: [id])
  productId String?
  product   Product? @relation(fields: [productId], references: [id], onDelete: Cascade)
  optionId  String?
  option    Option?  @relation(fields: [optionId], references: [id], onDelete: Cascade)
  amount    Decimal  @db.Decimal(12, 2)
  needsReview Boolean @default(false)        // imported gaps: M3390 TBD etc.
  @@unique([productId, regionId])
  @@unique([optionId, regionId])
}

model Company {
  id       String    @id @default(cuid())
  name     String
  street   String?
  city     String?
  state    String?
  postcode String?
  country  String?
  taxId    String?
  notes    String?
  regionId String
  region   Region    @relation(fields: [regionId], references: [id])
  contacts Contact[]
  documents Document[]
  createdAt DateTime @default(now())
}

model Contact {
  id        String  @id @default(cuid())
  companyId String
  company   Company @relation(fields: [companyId], references: [id], onDelete: Cascade)
  firstName String
  lastName  String?
  email     String?
  phone     String?
  position  String?
  isPrimary Boolean @default(false)
  documents Document[]
}

model Document {
  id             String         @id @default(cuid())
  type           DocumentType
  status         DocumentStatus @default(DRAFT)
  number         String?        @unique     // Q-AU-2026-001, assigned on finalize
  companyId      String
  company        Company        @relation(fields: [companyId], references: [id])
  contactId      String?
  contact        Contact?       @relation(fields: [contactId], references: [id])
  authorId       String
  author         User           @relation(fields: [authorId], references: [id])
  regionId       String
  region         Region         @relation(fields: [regionId], references: [id])
  issueDate      DateTime       @default(now())
  validityDays   Int?
  currency       String
  taxName        String
  taxRate        Decimal        @db.Decimal(5, 2)
  entitySnapshot Json?                       // frozen on finalize
  discountPct    Decimal?       @db.Decimal(5, 2)
  subtotal       Decimal        @default(0) @db.Decimal(12, 2)
  taxAmount      Decimal        @default(0) @db.Decimal(12, 2)
  total          Decimal        @default(0) @db.Decimal(12, 2)
  notes          String?
  items          DocumentItem[]
  lines          DocumentLine[]
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
}

model DocumentItem {
  id           String    @id @default(cuid())
  documentId   String
  document     Document  @relation(fields: [documentId], references: [id], onDelete: Cascade)
  productId    String?
  product      Product?  @relation(fields: [productId], references: [id])
  sortOrder    Int       @default(0)
  code         String                        // snapshot
  name         String                        // snapshot
  description  String?                       // snapshot
  unitPrice    Decimal   @db.Decimal(12, 2)  // snapshot
  discountPct  Decimal?  @db.Decimal(5, 2)
  serialNumber String?
  showImage    Boolean   @default(false)
  imageUrl     String?
  lines        DocumentLine[]
}

model DocumentLine {
  id         String        @id @default(cuid())
  documentId String
  document   Document      @relation(fields: [documentId], references: [id], onDelete: Cascade)
  itemId     String?                          // null = document-level line
  item       DocumentItem? @relation(fields: [itemId], references: [id], onDelete: Cascade)
  kind       LineKind
  refId      String?                          // optionId or productId
  code       String?
  name       String
  description String?
  qty        Int           @default(1)
  unitPrice  Decimal       @db.Decimal(12, 2)
  attributes Json?                            // { metres: 4, tables: 2 }
  showImage  Boolean       @default(false)
  sortOrder  Int           @default(0)
}

model ContentBlock {
  id        String  @id @default(cuid())
  key       String                             // terms.delivery, rsp.agreement, option.MTS
  regionId  String?
  region    Region? @relation(fields: [regionId], references: [id])
  title     String?
  body      String                             // markdown
  sortOrder Int     @default(0)
  @@unique([key, regionId])
}

model NumberSequence {
  id         String       @id @default(cuid())
  regionCode String
  docType    DocumentType
  year       Int
  counter    Int          @default(0)
  @@unique([regionCode, docType, year])
}

model Setting {
  key   String @id
  value Json
}
```

- [ ] **Step 2: `src/lib/db.ts`**

```ts
import { PrismaClient } from "@prisma/client";
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalForPrisma.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
```

- [ ] **Step 3: Run migration** (needs local Postgres: `docker compose up -d postgres` with `DATABASE_URL` pointing to `localhost:5432` in `.env`)

Run: `npx prisma migrate dev --name init`
Expected: migration created, client generated.

- [ ] **Step 4: Commit** `git add -A && git commit -m "feat: full Prisma schema + initial migration"`

---

### Task 5: Auth (credentials + magic link), route guard

**Files:**
- Create: `src/auth.ts`, `src/middleware.ts`, `src/app/login/page.tsx`, `src/app/api/auth/[...nextauth]/route.ts`, `src/lib/actions/auth.ts`

- [ ] **Step 1: `src/auth.ts`**

```ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { verify } from "@node-rs/argon2";
import { db } from "@/lib/db";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(creds) {
        const email = String(creds?.email ?? "").toLowerCase();
        const password = String(creds?.password ?? "");
        const user = await db.user.findUnique({ where: { email } });
        if (!user?.active || !user.passwordHash) return null;
        const ok = await verify(user.passwordHash, password);
        return ok ? { id: user.id, email: user.email, name: user.name } : null;
      },
    }),
    Nodemailer({
      server: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      },
      from: process.env.EMAIL_FROM,
      maxAge: 15 * 60, // magic link valid 15 min
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      // magic link: only pre-created active users may sign in
      const existing = await db.user.findUnique({ where: { email: user.email! } });
      return !!existing?.active;
    },
    async jwt({ token, user }) {
      if (user?.id) {
        const u = await db.user.findUnique({ where: { id: user.id } });
        token.role = u?.role;
        token.regionId = u?.regionId;
        token.uid = u?.id;
      }
      return token;
    },
    async session({ session, token }) {
      Object.assign(session.user, {
        id: token.uid, role: token.role, regionId: token.regionId,
      });
      return session;
    },
  },
});
```

- [ ] **Step 2: `src/app/api/auth/[...nextauth]/route.ts`**

```ts
import { handlers } from "@/auth";
export const { GET, POST } = handlers;
```

- [ ] **Step 3: `src/middleware.ts` — everything behind login**

```ts
import { auth } from "@/auth";
export default auth((req) => {
  const isPublic = req.nextUrl.pathname.startsWith("/login")
    || req.nextUrl.pathname.startsWith("/api/auth");
  if (!req.auth && !isPublic) {
    return Response.redirect(new URL("/login", req.nextUrl));
  }
});
export const config = { matcher: ["/((?!_next|favicon.ico|.*\\.(?:png|svg|jpg)).*)"] };
```

Note: `auth()` in middleware pulls Prisma via jwt callback — if the Edge runtime complains, split config (`auth.config.ts` without adapter for middleware) per Auth.js v5 docs; jwt/session callbacks only run in the Node runtime routes.

- [ ] **Step 4: Minimal `/login` page** — email+password form and "Send magic link" button, both posting to server actions in `src/lib/actions/auth.ts` that call `signIn("credentials", ...)` / `signIn("nodemailer", ...)`. Brand colors: `bg-brand` button, `text-brand-dark` headings. Show generic "Invalid credentials" on failure (no user enumeration).

- [ ] **Step 5: Verify manually** — with a user created in Task 6, credentials login redirects to `/`, wrong password shows error, unknown email + magic link does not send.

- [ ] **Step 6: Commit** `git commit -am "feat: auth — credentials + magic link, global route guard"`

---

### Task 6: Admin bootstrap script

**Files:**
- Create: `scripts/create-user.ts`

- [ ] **Step 1: Script — create/update a user from CLI**

```ts
import { hash } from "@node-rs/argon2";
import { db } from "../src/lib/db";

async function main() {
  const [email, password, role = "ADMIN", regionCode = "AU"] = process.argv.slice(2);
  if (!email) throw new Error("usage: tsx scripts/create-user.ts email [password] [ADMIN|MANAGER] [AU|US|UK]");
  const region = await db.region.findUnique({ where: { code: regionCode } });
  const passwordHash = password ? await hash(password) : undefined;
  const user = await db.user.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash, role: role as never, regionId: region?.id, active: true },
    create: { email: email.toLowerCase(), passwordHash, role: role as never, regionId: region?.id },
  });
  console.log("ok:", user.email, user.role);
}
main().finally(() => db.$disconnect());
```

- [ ] **Step 2: Run** `npx tsx scripts/create-user.ts hottabov@gmail.com <temp-password> ADMIN AU` (after Task 8 seeds regions; for local testing seed regions first or pass no region). Verify login works.

- [ ] **Step 3: Commit** `git commit -am "feat: CLI user bootstrap script"`

---

### Task 7: Catalog extraction script (Excel → JSON)

**Files:**
- Create: `scripts/extract-catalog.ts`
- Output (committed): `prisma/seed-data/catalog.json`

Reference: `docs/reference/price-list-analysis.md`. Source: `RAW/11 Price List Australia 2026-05-28.xlsx`.

- [ ] **Step 1: Write extraction script**

Approach: per-sheet config; find the header row (cell containing `Machine` or `CODE` or `Description`); read rows below; a row is an item when it has a code cell and a numeric price cell. Machines vs options split by code regex.

```ts
import * as XLSX from "xlsx";
import { writeFileSync, mkdirSync } from "node:fs";

type Item = { code: string; name: string; price: number | null; needsReview: boolean };
type SheetCfg = {
  sheet: string; seriesCode: string; seriesName: string;
  machineRe?: RegExp;          // rows matching → products, rest → options
  maxDiscountPct?: number;
};

const cfgs: SheetCfg[] = [
  { sheet: "M-series", seriesCode: "M", seriesName: "M-Series", machineRe: /^M\d{4,5}$/ },
  { sheet: "L-Series", seriesCode: "L", seriesName: "L-Series", machineRe: /^L-\d+/, maxDiscountPct: 10 },
  { sheet: "Punchline", seriesCode: "P", seriesName: "Punchline", machineRe: /^P-\d+/ },
  { sheet: "Software", seriesCode: "SW", seriesName: "Software" },                 // all options
  { sheet: "Leather Nesting System", seriesCode: "LNS", seriesName: "Leather Nesting System", machineRe: /^LNS/ },
  { sheet: "EasyLoader", seriesCode: "EL", seriesName: "EasyLoader", machineRe: /^EL/ },
  { sheet: "EasyFeeder", seriesCode: "EF", seriesName: "EasyFeeder", machineRe: /^EF/ },
  { sheet: "FabricPro", seriesCode: "FP", seriesName: "FabricPro", machineRe: /^F[MP]/ },
];

const wb = XLSX.read(require("node:fs").readFileSync("RAW/11 Price List Australia 2026-05-28.xlsx"));

function extractSheet(cfg: SheetCfg) {
  const ws = wb.Sheets[cfg.sheet];
  if (!ws) throw new Error(`sheet not found: ${cfg.sheet}`);
  const rows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const products: Item[] = [], options: Item[] = [];
  for (const row of rows) {
    const cells = row.map((c) => (typeof c === "string" ? c.trim() : c));
    const code = cells.find((c) => typeof c === "string" && /^[A-Z][A-Z0-9-]{1,15}$/.test(c as string)) as string | undefined;
    if (!code || /^(QTY|PRICE|PRCE|TOTAL|CODE)$/i.test(code)) continue;
    const nums = cells.filter((c): c is number => typeof c === "number" && c > 0);
    const price = nums.length ? nums[0] : null;               // first positive number = End User Price AUD
    const name = (cells.find((c) => typeof c === "string" && (c as string).length > 20) as string) ?? code;
    const item: Item = { code, name, price, needsReview: price === null };
    (cfg.machineRe?.test(code) ? products : options).push(item);
  }
  return { ...cfg, products, options };
}

const series = cfgs.map(extractSheet);
// X-Calibre = clone of M-Series with XC- prefixed codes, same prices (to be revised)
const m = series.find((s) => s.seriesCode === "M")!;
series.splice(1, 0, {
  ...m, sheet: "(clone)", seriesCode: "XC", seriesName: "X-Calibre",
  products: m.products.map((p) => ({ ...p, code: `XC-${p.code.slice(1)}`, needsReview: true })),
  options: [],  // X-Calibre reuses M-Series options via compatibility
} as never);

mkdirSync("prisma/seed-data", { recursive: true });
writeFileSync("prisma/seed-data/catalog.json", JSON.stringify({ extractedAt: new Date().toISOString(), series }, null, 2));
console.log(series.map((s) => `${s.seriesName}: ${s.products.length} products, ${s.options.length} options`).join("\n"));
```

**Important:** the heuristics above WILL need tuning against the real file (duplicate option rows, "MTS additional travel p/Metre" style codes with spaces, junk rows like "Do we eliminate this?"). Iterate: run, inspect JSON, adjust regexes/filters until counts match `docs/reference/price-list-analysis.md` (~23 machines + X-Calibre clone, ~60 options). Deduplicate codes (keep first occurrence).

- [ ] **Step 2: Run** `npm run extract:catalog`, inspect `prisma/seed-data/catalog.json` manually. Machines M3180…M10390 present, prices match spot-checks against Excel (M3180 = 175000, L-180 = 135000, P-180 = 10660).

- [ ] **Step 3: Commit** `git add scripts prisma/seed-data && git commit -m "feat: Excel catalog extraction -> committed JSON"`

---

### Task 8: Catalog validation test

**Files:**
- Create: `tests/catalog.test.ts`, `vitest.config.ts`

- [ ] **Step 1: Write test (against committed JSON)**

```ts
import { describe, it, expect } from "vitest";
import catalog from "../prisma/seed-data/catalog.json";

const all = catalog.series.flatMap((s: any) => [...s.products, ...s.options]);

describe("catalog.json", () => {
  it("has M-Series with 12 machines", () => {
    const m = catalog.series.find((s: any) => s.seriesCode === "M");
    expect(m.products.length).toBe(12);
  });
  it("has X-Calibre clone matching M-Series product count", () => {
    const m = catalog.series.find((s: any) => s.seriesCode === "M");
    const xc = catalog.series.find((s: any) => s.seriesCode === "XC");
    expect(xc.products.length).toBe(m.products.length);
  });
  it("spot prices", () => {
    const by = (c: string) => all.find((i: any) => i.code === c);
    expect(by("M3180").price).toBe(175000);
    expect(by("L-180").price).toBe(135000);
    expect(by("P-180").price).toBe(10660);
  });
  it("no duplicate codes", () => {
    const codes = all.map((i: any) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it("every item priced or flagged needsReview", () => {
    for (const i of all) expect(i.price !== null || i.needsReview).toBe(true);
  });
});
```

- [ ] **Step 2: Run** `npm test` → all pass (fix extraction script, not the test, if counts are off).

- [ ] **Step 3: Commit** `git commit -am "test: catalog extraction validation"`

---

### Task 9: Seed script

**Files:**
- Create: `prisma/seed.ts`

- [ ] **Step 1: Write seed — regions, series, products, options, AU prices, compatibility**

```ts
import { db } from "../src/lib/db";
import catalog from "./seed-data/catalog.json";

async function main() {
  const regions = [
    { code: "AU", name: "Australia", currency: "AUD", taxName: "GST", taxRate: 10,
      entityName: "Pathfinder Australia Pty Ltd", entityLegalId: "ABN 64 072 458 667",
      entityAddress: "12 Did Ct, Tullamarine Vic. 3043, Australia",
      bankDetails: { bank: "ANZ Westfield", account: "Pathfinder Australia Pty Ltd",
        swift: "ANZBAU3M", bsb: "013 442", accountNo: "4405 63886" } },
    { code: "US", name: "United States", currency: "USD", taxName: "Sales Tax", taxRate: 0, entityName: "Pathfinder USA" },
    { code: "UK", name: "United Kingdom", currency: "GBP", taxName: "VAT", taxRate: 20, entityName: "Pathfinder UK" },
  ];
  for (const r of regions) {
    await db.region.upsert({ where: { code: r.code }, update: r as never, create: r as never });
  }
  const au = await db.region.findUniqueOrThrow({ where: { code: "AU" } });

  let sort = 0;
  for (const s of catalog.series as any[]) {
    const series = await db.series.upsert({
      where: { code: s.seriesCode },
      update: { name: s.seriesName, maxDiscountPct: s.maxDiscountPct ?? null },
      create: { code: s.seriesCode, name: s.seriesName, maxDiscountPct: s.maxDiscountPct ?? null, sortOrder: sort++ },
    });
    for (const [i, p] of s.products.entries()) {
      const product = await db.product.upsert({
        where: { code: p.code },
        update: { name: p.name, seriesId: series.id },
        create: { code: p.code, name: p.name, seriesId: series.id, sortOrder: i },
      });
      if (p.price != null || p.needsReview) {
        await db.price.upsert({
          where: { productId_regionId: { productId: product.id, regionId: au.id } },
          update: { amount: p.price ?? 0, needsReview: p.needsReview },
          create: { productId: product.id, regionId: au.id, amount: p.price ?? 0, needsReview: p.needsReview },
        });
      }
    }
    for (const [i, o] of s.options.entries()) {
      const option = await db.option.upsert({
        where: { code: o.code },
        update: { name: o.name },
        create: { code: o.code, name: o.name, sortOrder: i },
      });
      await db.price.upsert({
        where: { optionId_regionId: { optionId: option.id, regionId: au.id } },
        update: { amount: o.price ?? 0, needsReview: o.needsReview },
        create: { optionId: option.id, regionId: au.id, amount: o.price ?? 0, needsReview: o.needsReview },
      });
      // options from a sheet are compatible with that sheet's series
      await db.optionCompatibility.upsert({
        where: { optionId_seriesId_productId: { optionId: option.id, seriesId: series.id, productId: null as never } },
        update: {},
        create: { optionId: option.id, seriesId: series.id },
      }).catch(async () => {
        await db.optionCompatibility.create({ data: { optionId: option.id, seriesId: series.id } });
      });
      // M-Series options also compatible with X-Calibre
      if (s.seriesCode === "M") {
        const xc = await db.series.findUnique({ where: { code: "XC" } });
        if (xc) await db.optionCompatibility.createMany({
          data: [{ optionId: option.id, seriesId: xc.id }], skipDuplicates: true });
      }
    }
  }
  console.log("seed complete");
}
main().finally(() => db.$disconnect());
```

Note: Prisma composite upsert with nullable member may need `findFirst`+`create` instead — adjust to what compiles; goal is idempotent seed (`npm run db:seed` twice = no dupes, no errors). X-Calibre series is created before M-Series options run only if catalog.json orders XC after M — it does (spliced at index 1); if ordering bites, do two passes: all series first, then options.

- [ ] **Step 2: Run seed twice** — `npm run db:seed && npm run db:seed`. Second run must not error or duplicate.

- [ ] **Step 3: Verify in DB**

```bash
npx prisma studio # spot-check: 3 regions, 9 series, ~35 products (12 M + 12 XC + rest), ~60 options, AU prices
```

- [ ] **Step 4: Commit** `git commit -am "feat: idempotent DB seed from catalog.json (regions, catalog, AU prices, compatibility)"`

---

### Task 10: Health check + protected home

**Files:**
- Create: `src/app/api/health/route.ts`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Health route (public not required — used by CI/deploy check, keep behind nothing):** exclude `/api/health` in middleware `isPublic` list, then:

```ts
import { db } from "@/lib/db";
export async function GET() {
  await db.$queryRaw`SELECT 1`;
  return Response.json({ ok: true });
}
```

- [ ] **Step 2: Replace `page.tsx`** with a minimal authenticated dashboard: greeting with `session.user.email`, role badge, sign-out button, placeholder cards "Documents / Clients / Catalog" in brand colors. Server component using `await auth()`.

- [ ] **Step 3: Verify** login → dashboard, `curl localhost:3000/api/health` → `{"ok":true}`.

- [ ] **Step 4: Commit** `git commit -am "feat: health endpoint + authenticated dashboard shell"`

---

### Task 11: CI + auto-deploy

**Files:**
- Create: `.github/workflows/deploy.yml`, `docs/runbook.md`

- [ ] **Step 1: Workflow**

```yaml
name: CI & Deploy
on:
  push: { branches: [main] }
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx prisma generate
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
  deploy:
    needs: ci
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            set -e
            cd /opt/pathquote
            git pull --ff-only
            docker compose up -d --build
            docker compose exec -T app npx prisma migrate deploy
            curl -fsS http://127.0.0.1:3010/api/health
```

GitHub repo secrets needed: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`.

- [ ] **Step 2: `docs/runbook.md`** — one-time VPS setup:

```markdown
# Runbook
## One-time VPS setup
1. `git clone git@github.com:hottabov/pf-invoice.git /opt/pathquote`
2. `cp .env.example .env` → fill real values (`openssl rand -base64 32` for AUTH_SECRET)
3. `docker compose up -d --build && docker compose exec app npx prisma migrate deploy`
4. Seed: `docker compose exec app npx tsx prisma/seed.ts`
5. Admin: `docker compose exec app npx tsx scripts/create-user.ts you@example.com 'StrongPass' ADMIN AU`
6. Nginx site:
    server {
      server_name q.pathfindercut.com;
      location / { proxy_pass http://127.0.0.1:3010; proxy_set_header Host $host;
                   proxy_set_header X-Forwarded-Proto https; client_max_body_size 25m; }
    }
   + certbot for TLS.
## Backups
`0 3 * * * docker compose -f /opt/pathquote/docker-compose.yml exec -T postgres pg_dump -U pathquote pathquote | gzip > /opt/backups/pq-$(date +\%F).sql.gz` (keep 14 days)
```

- [ ] **Step 3: Push, watch Actions run green, open https://q.pathfindercut.com/login**

- [ ] **Step 4: Commit** `git commit -am "ci: lint/typecheck/test + SSH deploy workflow, runbook"`

---

## Self-review notes

- Spec coverage (phases 1-2): scaffold ✓, brand ✓, docker/gotenberg ✓ (container up; PDF usage comes in phase 5), schema all entities ✓, auth both methods + no-self-signup ✓, seed with X-Calibre clone + needsReview gaps ✓, compatibility matrix seeded per sheet ✓, CI/deploy ✓, backups in runbook ✓.
- Known risk: extraction heuristics (Task 7) and Prisma composite-upsert nuances (Task 9) — both tasks contain explicit iterate-and-verify steps instead of pretending exact cell coordinates are known.
- Rate limiting on login deferred to Phase 7 polish (documented in roadmap phase 7).
