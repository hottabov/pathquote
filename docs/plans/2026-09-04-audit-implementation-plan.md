# План впровадження за аудитом 2026-09-04

Джерело: `docs/audit/2026-09-04-audit.md`. Кожен крок = один PR, з критерієм готовності
і способом перевірки. Порядок — за ефектом на деплой, потім за ризиком. Кроки всередині
фази незалежні (можна паралелити), фази — послідовні.

Статуси: `[ ]` не почато · `[~]` в роботі · `[x]` готово. Оновлювати в цьому файлі.

---

## Фаза 0 — Baseline ✅ (2026-09-04)

- [x] **0.1** VPS: 4 vCPU, 7901 MB RAM (2743 used, swap 2047/488), Docker 29.7.2, Compose v5.5.0.
- [x] **0.2** `docker compose build app` (теплий) — 0.54 с, усі 21 шар CACHED. Холодний не заміряно (prune перервано вручну).
- [x] **0.3** GHA: `ci` — **1m27s**; `verify-db` — **7m36s**; `deploy` — **7m36s**.

| Метрика | Значення |
|---|---|
| VPS vCPU / RAM | 4 / 7.9 GB (+2 GB swap, 488 MB зайнято → пам'ять під тиском) |
| `docker compose build app` warm | 0.54 с (21/21 CACHED) |
| `docker compose build app` cold | не заміряно — див. 0.2b |
| GHA `ci` | 1m 27s |
| GHA `verify-db` | **7m 36s** |
| GHA `deploy` | 7m 36s |
| push → healthy | ≈ 9 хв |

### Що з цього випливає (перегляд пріоритетів)

1. **VPS не такий вузький, як припускалось** — 4 vCPU / 7.9 GB. Але `docker builder prune -af`
   показав **десятки GB** осілих шарів (кілька записів по 1.5–1.6 GB, «5 days ago»), тобто
   збірки накопичуються і диск під тиском. Додано `docker image prune -f` у крок 1.4.
2. **`verify-db` (7m36s) — це критичний шлях, а не збірка.** Він дорівнює всьому часу
   `deploy` і в 5 разів довший за `ci`. Ціна: другий `npm ci` + `migrate` + **seed двічі**.
   `prisma/seed.ts` (545 рядків) виконує сотні послідовних `upsert`/`findUnique`/`create`
   у циклах, без жодного `createMany` (`seed.ts:96,151,172,257,277,288,329,380,437`) —
   ~1000+ round-trip'ів за прогін, ×2 прогони. **Фаза 3 піднімається у пріоритеті вище
   Фази 2**, а до неї варто додати крок 3.6 (батчинг seed'у).
3. Теплий build на VPS = 0.5 с, отже 7m36s у `deploy` — це переважно **холодні шари**
   (будь-яка зміна у `COPY . .` контексті ⇒ повний `npm ci` + `next build`) плюс
   **другий** `up -d --build`. Обидві причини знімає Фаза 1.

- [ ] **0.2b** Після Фази 1 заміряти на VPS холодний build чесно:
  `docker builder prune -af && time docker compose build app` (дочекатися завершення prune).
- [ ] **0.3b** У GHA відкрити останній `verify-db` і записати тривалість **кожного кроку**
  окремо (`npm ci` / `Migrate` / `Seed (first run)` / `Seed (second run)` / count-check) —
  це визначить, чи Фаза 3 має чинити батчинг seed'у, чи достатньо прибрати другий `npm ci`.

---

## Фаза 1 — Деплой без переносу збірки ✅ код готовий, чекає на деплой

Мета: прибрати очевидні дублі, не міняючи топологію. Очікуваний виграш: 20–40 % часу деплою.

- [x] **1.1** `.dockerignore` переписано: `.claude/` (3.6 MB), `tests/`, `scripts/`, `docs/`, `data/`, `RAW/`, `*.md`, `*.tsbuildinfo`, `.DS_Store`, compose-файли, `vitest.config.ts`, `eslint.config.mjs`.
- [x] **1.2** `Dockerfile`:
  - `COPY . .` → явний список build-inputs (`package.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `public/`, `src/`, `prisma/seed-lib.ts`, `prisma/seed-data/content-blocks.json`).
    Дві prisma-залежності — не випадковість: `src/lib/content-placeholders.ts:1-2` імпортує саме їх.
  - Прибрано `npx prisma generate` зі стадії `build` (postinstall у `deps` уже згенерував клієнт; `generate` не потребує `DATABASE_URL`, бо `datasource` містить лише `provider`).
  - Placeholder-секрети `ENV` → `ARG` — більше не осідають у жодному образі.
  - **Тонкий `tools`**: тепер `FROM node:22-alpine` + `deps`, а не `FROM build`. Містить `node_modules`, `package.json`, `prisma.config.ts`, `tsconfig.json`, `prisma/`, `scripts/`, `src/` — усе, що треба для `db:migrate`, `db:seed`, `user:create`, `images:import`; без `.next` і без build-секретів.
    *(Винесено з Фази 2: явний `COPY` у `build` неможливий, доки `tools` успадковує `build`.)*
  - `run`: `NEXT_TELEMETRY_DISABLED=1`; `prisma/` тепер береться з `tools` (байт-у-байт як було — чи потрібна вона там взагалі, з'ясовує 2.2).
- [x] **1.3** `next.config.ts`: `typescript.ignoreBuildErrors: process.env.SKIP_TYPECHECK === "1"` (Dockerfile ставить `SKIP_TYPECHECK=1`; CI вже gate'ить `tsc`, а `deploy` стартує лише після зеленого `ci`); `env.APP_VERSION: process.env.APP_VERSION || process.env.npm_package_version` + `ARG APP_VERSION` у Dockerfile — готово до передачі git SHA у Фазі 2.
- [x] **1.4** `deploy.yml`: прибрано `npx prisma generate` в обох jobs; `up -d --build` → `up -d app gotenberg`; `docker image prune -f` після успішного health-check.
- [x] **1.5** `package.json`: `shadcn` → devDependencies, `dotenv@^17.4.2` доданий явно (використовують `prisma.config.ts:3`, `prisma/seed.ts:14`, `scripts/*`; раніше резолвився лише транзитивно через `prisma`). `package-lock.json` оновлено — діф лише `"dev": true` на транзитивному дереві shadcn, жодного нового пакета.
- [x] **1.6a** Локальна перевірка: `npm run lint` ✅, `npm run typecheck` ✅, `vitest` 52/52 файли, 1249/1249 тестів ✅.
- [x] **1.6b** `npm ci` з нового lock ✅, typecheck ✅, 1249 тестів ✅ (Mac, 1.75 с).
- [x] **1.6c** `docker build --target build|tools|run` локально (Mac) — **знайшов баг**:
  `.dockerignore` виключав `scripts/`, а тонкий `tools` їх копіює → `COPY scripts ./scripts`
  падав з `"/scripts": not found`. Виправлено: `scripts` прибрано з `.dockerignore`
  (потрапляє тільки у `tools`-стадію, у `build` — ні).
  Другим заходом прибрано warning `SecretsUsedInArgOrEnv`: `DATABASE_URL`/`AUTH_SECRET`
  більше не `ARG` і не `ENV`, а inline-префікс на самому `RUN npm run build` — плейсхолдера
  тепер немає ні в шарі, ні в `docker history`.
- [x] **1.6d** Три `docker build --target build|tools|run` — усі три пройшли, warning зник.
  `build` = 14.3 с. `docker run pq-tools-check` показав 31 міграцію + `migration_lock.toml`,
  усі 8 скриптів, `tsx 4.23.12`, `prisma/@prisma/client 7.10.0` — тонкий `tools` робочий.
- [x] **1.6e** Деплой на `main` (Фази 1–3 одним пушем) — **зелений, 2026-09-04**.

## Результат Фаз 1–3 ✅

| Job | До | Після (перший run, холодний кеш GHA) |
|---|---|---|
| `ci` (lint/typecheck/test) | 1m 27s | **1m 39s** (тепер включає ще й міграції, diff, seed ×2, verify) |
| `verify-db` | 7m 36s | — (злито в `ci`) |
| `build` (GHA → GHCR) | — | 3m 41s |
| `deploy` (VPS) | 7m 36s | **44s** |
| **push → healthy** | **≈ 15m** (max(1m27, 7m36) + 7m36) | **≈ 6m** (1m39 + 3m41 + 44s) |

- **Деплой на VPS: 7m36s → 44s (у 10 разів).** VPS більше нічого не збирає й не експортує —
  тільки `pull` змінених шарів, міграції, `up`, health.
- **`verify-db` зник як окремий job**, а `ci` при цьому подорожчав лише на 12 с — попри те,
  що ввібрав migrate + `migrate diff` + seed ×2 + verify. Тобто ті 7m36s були майже
  повністю другим `npm ci` і накладними другого runner'а.
- **Загалом ≈15 хв → ≈6 хв**, і це на **холодному** кеші GHA. `build` (3m41s) — єдине, що
  ще має запас: наступні прогони перевикористають шар `npm ci`.

- [x] **1.6f** Теплий прогін заміряно — **усталена швидкість досягнута**:

  | Job | Холодний | **Теплий** |
  |---|---|---|
  | `ci` | 1m 39s | **1m 19s** |
  | `build` | 3m 41s | **1m 43s** |
  | `deploy` | 44s | **18s** |
  | **push → healthy** | ≈ 6m 04s | **≈ 3m 20s** |

## Підсумок: 15m → 3m20s

| | До | Після (теплий) | Виграш |
|---|---|---|---|
| `deploy` (крок на VPS) | 7m 36s | **18s** | **×25** |
| push → healthy | ≈ 15m 12s | **≈ 3m 20s** | **×4.6** |

Розкладка «до»: `ci` 1m27 паралельно з `verify-db` 7m36 → критичний шлях 7m36, далі
`deploy` 7m36. Разом ≈15m12s.

`build` 3m41 → 1m43 підтверджує, що кеш GHA працює: шар `npm ci` (115 с холодного часу)
більше не перебудовується.

- [x] **10.0** Розмір рантайм-образу — **407 MB на диску, 102 MB контенту** (те, що
  реально тягнеться з реєстру). При `node_modules` на 1231 MB це доводить, що
  `output: "standalone"` трасує лише використане і **залежності в продакшн не їдуть**.
  Саме тому `deploy` займає 18 с: інкрементальний pull кількох шарів.

### Заміри холодної збірки (2026-09-04)

**VPS, старий Dockerfile** (`docker builder prune -af` + `image prune -af` → 2.46 GB звільнено):

| Крок | Час |
|---|---|
| transferring context | 0.2 с (**14.08 MB**) |
| `npm ci` (deps) | **114.9 с** |
| `COPY --from=deps node_modules` | 8.8 с |
| `npx prisma generate && npm run build` | **45.9 с** |
| export + unpack | 5.0 + 1.1 с |
| **разом** | **3m 04s** |

**Mac, новий Dockerfile** (`--target build`):

| Крок | Час |
|---|---|
| transferring context | 0.1 с (**2.68 MB** ← було 14.08) |
| `npm ci` (deps) | 111.8 с |
| `COPY --from=deps node_modules` | 10.9 с |
| `npm run build` (без `prisma generate`, `SKIP_TYPECHECK=1`) | **13.5 с** ← було 45.9 |
| export | 8.0 с |

Висновки:

1. **`SKIP_TYPECHECK` + прибраний `prisma generate` дають ~30 с** на кожній збірці
   (45.9 → 13.5 с; частина різниці — швидший Mac, але порядок величини той самий).
2. **Контекст зменшився з 14.08 MB до 2.68 MB** — і, що важливіше, правка `docs/`,
   `.claude/` чи `tests/` більше не інвалідовує шар `build`.
3. **`npm ci` = 115 с, або 62 % холодної збірки.** Шар `deps` кешується і перебудовується
   лише при зміні `package*.json`, тому у звичайному деплої його немає — але після
   будь-якого `builder prune` або зміни залежностей він повертається. У Фазі 2 це знімає
   кеш GHA (`cache-from: type=gha`), який переживає prune на VPS, бо VPS більше не збирає.
4. **3m 04s збірки ≠ 7m 36s job'а `deploy`.** Різницю (~4.5 хв) з'їдають: збірка+експорт
   `tools` (старий `FROM build` = другий образ на ~1.6 GB), `git pull`, `up -d postgres`,
   міграції, **другий** `up -d --build` і health-loop. Фаза 1 знімає другий `--build`;
   решту знімає Фаза 2, після якої VPS взагалі нічого не збирає.

### 0.3b — seed виміряно: гіпотеза спростована ❌

`time docker compose run --rm tools npm run db:seed` на VPS = **1m 12.9s**, але з них:

| Складова | Час |
|---|---|
| перезбірка образу `tools`: **exporting layers** | 51.8 с |
| перезбірка образу `tools`: **unpacking** | 16.6 с |
| решта (створення контейнера + **сам seed**) | **≈ 4 с** |

**Seed — це ~4 секунди, а не 3 хвилини.** Крок **3.6 (батчинг `prisma/seed.ts` на
`createMany`) скасовано** — він не окупається, а це була єдина зміна в плані, що чіпає
продакшн-дані. Ризик прибрано з плану повністю.

Натомість цифра викрила справжнього ворога на VPS: **експорт і розпакування образу —
68 с на один образ**. Локальна збірка платить цю ціну щоразу; `docker pull` з реєстру —
ні, бо тягне лише змінені шари, а шар `node_modules` (1.2 GB) змінюється тільки разом із
`package-lock.json`. Це і є головний аргумент за Фазу 2, сильніший за економію CPU.

### Ризики Фази 1 і як їх ловити

| Ризик | Симптом | Дія |
|---|---|---|
| Явний `COPY` пропустив файл, потрібний `next build` | build падає з `Module not found` | додати шлях у `build`-стадію; це єдина причина, чому 1.6b обов'язковий перед Фазою 2 |
| `tools` більше не `FROM build` | `docker compose run --rm tools npm run db:seed` падає | перевірити вручну (див. «Що зробити руками», п. 3) |
| `run` тягне `prisma/` з `tools` | `docker compose build app` тепер завжди будує і `tools` | очікувано; заодно прибирає стару пастку «міграції з несвіжого образу» |
| `SKIP_TYPECHECK=1` ховає помилку типів | зламаний прод при зеленому CI неможливий, бо `deploy` needs `ci` | якщо колись вимкнути gate у `ci` — прибрати і `SKIP_TYPECHECK` |

---

## Фаза 2 — Збірка в GHA + GHCR, VPS лише pull (1–2 PR, середній ризик, ~3 год)

Мета: VPS більше не компілює. Очікуваний виграш: VPS-крок < 1 хв; загалом push → healthy ≈ 3–5 хв.

- [x] **2.1** Тонкий `tools` уже зроблено у Фазі 1 (був блокером явного `COPY`).
  `--mount=type=cache` **свідомо не додано**: у GHA кеш дає `cache-from/to: type=gha`,
  а на VPS збірки більше не буде — mount-кеш там нічого не кешував би між деплоями.
- [x] **2.2** Перевірено опосередковано: `run` збирається і стартує з поточним
  `COPY --from=build node_modules/.prisma`. Питання «чи потрібна `prisma/` у runtime»
  лишається відкритим — див. 2.9.
- [x] **2.3** Job `build` (needs `ci`, лише `main`): `docker/build-push-action@v6` для
  цілей `run` і `tools`, теги `:${sha}` і `:latest`, `cache-from/to: type=gha,mode=max`,
  `permissions: packages: write`, `provenance: false` (плоский однопл. образ замість
  manifest list з атестацією — саме те, що передбачувано тягне compose).
  `build-args: APP_VERSION=${{ github.sha }}` — тепер збірка позначена комітом.
- [x] **2.4** `docker-compose.yml`: додано `image: ghcr.io/hottabov/pathquote{,-tools}:${TAG:-latest}`.
  `build:` **залишено** обом сервісам — на VPS використовується лише `image:` (workflow
  тягне образ до старту), а локально `docker compose build` працює як раніше.
- [ ] **2.5** VPS одноразово: `docker login ghcr.io`. **Робить власник** — покроково в
  `docs/runbook.md` §1 крок 3. Увага: GHCR приймає **лише classic PAT** зі скоупом
  `read:packages`; fine-grained токени до нього не автентифікуються взагалі
  (перевірено в docs.github.com 2026-09-04, у першій редакції плану було неточно).
- [x] **2.6** VPS-скрипт: `export TAG=$GITHUB_SHA` → `docker compose --profile tools pull app tools`
  → `up -d postgres` → `run --rm tools npx prisma migrate deploy` → `up -d app gotenberg`
  → health loop → `docker image prune -f`. `git pull` залишено, але тепер лише заради
  `docker-compose.yml`, не коду.
- [x] **2.7** Runbook: новий розділ «2b. What a deploy actually does» + «Rolling back»
  (`TAG=<sha> docker compose up -d app`, із застереженням, що міграції не відкочуються).
- [ ] **2.8** Перевірка: два деплої поспіль (холодний кеш GHA, потім теплий); записати часи.
- [ ] **2.9** Після першого успішного деплою перевірити, чи runtime взагалі читає `prisma/`:
  `docker compose exec app ls prisma` і спробувати прибрати `COPY --from=tools /app/prisma`
  окремим PR. Prisma 7 з driver-адаптером інлайнить схему в клієнт, тож директорія
  ймовірно зайва — але це перевіряється тільки на живому контейнері.

Ескіз `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN --mount=type=cache,target=/root/.npm npm ci   # postinstall = prisma generate, один раз

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json next.config.ts tsconfig.json postcss.config.mjs components.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY public ./public
COPY src ./src
ARG GIT_SHA=dev
ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ARG AUTH_SECRET="build-time-placeholder"
ENV NEXT_TELEMETRY_DISABLED=1 SKIP_TYPECHECK=1 APP_VERSION=$GIT_SHA
RUN --mount=type=cache,target=/app/.next/cache npm run build

FROM node:22-alpine AS tools
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
CMD ["npx", "prisma", "migrate", "deploy"]

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/src/lib/production-forms/templates ./src/lib/production-forms/templates
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
```

Ескіз job'ів `deploy.yml` (фрагмент):

```yaml
  build:
    needs: ci
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@v6
        with:
          context: .
          target: run
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }},ghcr.io/${{ github.repository }}:latest
          build-args: GIT_SHA=${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - uses: docker/build-push-action@v6
        with:
          context: .
          target: tools
          push: true
          tags: ghcr.io/${{ github.repository }}-tools:${{ github.sha }},ghcr.io/${{ github.repository }}-tools:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

---

## Фаза 3 — CI: один job, verify-db як тест (1 PR, ~2 год)

- [x] **3.1** `verify-db` злито в `ci` (`services: postgres`) — один runner, один `npm ci`
  замість двох. Job перейменовано на «Lint, typecheck, test, verify DB».
- [x] **3.2** Доданий крок `prisma migrate diff … --exit-code` — ловить `schema.prisma`
  без відповідної міграції.
  **Виправлено після падіння run #33875029530:** Prisma 7 переписала інтерфейс команди —
  `--to-schema-datamodel` → `--to-schema`, а `--shadow-database-url` прибрано зовсім
  (`unknown or unexpected option`). Варіант `--from-migrations` тепер вимагає
  `datasource.shadowDatabaseUrl` у `prisma.config.ts` плюс другу базу; узято
  `--from-config-datasource --to-schema`, який порівнює вже змігровану БД зі схемою —
  без зайвої бази і з сильнішою гарантією (перевіряє застосований результат, а не
  повторне програвання міграцій). Крок переставлено **після** `Migrate`.
  Прапорці перевірено локально проти недосяжної БД: невідомий прапорець падає до
  з'єднання, валідний — на `P1001`.
- [x] **3.3** Inline CJS-скрипт (60 рядків у YAML) → **`scripts/verify-seed.ts`** + npm-скрипт
  `db:verify-seed`. Під `tsx` він імпортує `seed-lib.ts`, тому `regions` тепер теж виводиться
  з даних, а не лишається літералом (саме через цю неможливість імпорту стара версія і
  дрейфувала). Обидва прогони seed'у залишені — вони по 4 с, ідемпотентність дешева.
- [x] **3.4** ~~vitest projects~~ — не знадобилось: перевірка seed'у стала звичайним
  скриптом, окремий інтеграційний проєкт у vitest не потрібен.
- [ ] **3.5** (опційно, згодом) `paths-filter`: seed-кроки лише при змінах у `prisma/**`.
- [x] ~~**3.6** Батчинг seed'у~~ — **скасовано 2026-09-04**. Замір показав seed ≈ 4 с
  (уся видима тривалість припадала на перезбірку образу `tools`, див. 0.3b). Переписувати
  `prisma/seed.ts` немає сенсу, і це прибирає з плану єдину зміну, що чіпала продакшн-дані.
  Оригінальний текст кроку залишено нижче лише як запис розсліду.

<details>
<summary>Скасований крок 3.6 (для історії)</summary>

- **Батчинг seed'у** (додано після baseline: `verify-db` = 7m36s, найдовший job).
  `prisma/seed.ts` виконує сотні послідовних запитів у циклах, жодного `createMany`:
  regions (`:96`), series (`:151`), retired options (`:172`), products (`:257`), options (`:277`),
  AU prices (`:288`), US prices (`:329`), compatibility (`:380`, `:437` — вкладений цикл із
  `findMany` + `delete` на кожен рядок). Порядок дій:
  1. спочатку 0.3b — виміряти, скільки з 7m36s припадає саме на seed;
  2. якщо seed домінує: замінити цикли на `createMany({ skipDuplicates: true })` + один
     `updateMany` на зміни, а існування перевіряти одним `findMany` наперед замість
     `findUnique` у циклі; зберегти ідемпотентність (тест з 3.3 її і перевіряє);
  3. якщо домінує `npm ci` — достатньо злиття jobs (3.1).

---

## Фаза 4 — Тести: конфіг + typecheck ✅ 2026-09-05

- [x] **4.1** `vitest.config.ts`: `isolate: false`, `pool: 'threads'`. `typecheck: { enabled: false }`
  свідомо **не** додано — це повтор дефолта Vitest, тобто рівно той коментар «що», який
  забороняє house style; натомість один рядок пояснює, **де** типи тестів перевіряються.
  Заміряно: `vitest run` **12.15s → 5.91s** (import 15.03 → 10.39 с, tests 1.25 → 0.85 с).
  Прогнано двічі, результати по файлах побайтово ідентичні — прихованої залежності від
  порядку немає, тобто `isolate: false` тут безпечний.
- [x] **4.2** `tsconfig.json`: `exclude: ["node_modules", "tests"]`. Доведено через
  `tsc --noEmit --listFiles`: файлів із `/tests/` було 52, стало **0**; файлів із `src/`
  як було **207**, так і лишилось. `tsc --noEmit` 5.74 → 4.58 с.
- [x] **4.3** Новий `tests/tsconfig.json`. Тонкість, знайдена експериментом, а не здогадкою:
  успадковані `include`/`exclude` резолвляться відносно **батьківської** теки, тож
  батьківський `"tests"` виключав тут геть усе і `tsc -p tests` падав з TS18003 —
  довелось перевизначити `exclude`. `paths` навпаки успадковується коректно.
  `npx tsc -p tests --noEmit` — 0 помилок.
- [ ] **4.2** `tsconfig.json`: `exclude: ["node_modules", "tests"]`; створити `tests/tsconfig.json` (`extends: "../tsconfig.json"`, `include: ["./**/*.ts"]`) для редактора. Опційно у CI `npx tsc -p tests --noEmit`.
- [ ] **4.3** Перевірка: `npm test` ≈ 5 с; `npm run typecheck` не типізує `tests/`.

---

## Фаза 5 — Безпека / коректність домену ✅ 2026-09-05

- [x] **5.1** ✅ `recalcDocument`, `recalcAndEnforce`, `RecalcClient`, `RecalcResult` і два
  sentinel-и (`NegativeSubtotalError`, `ConcessionCapError` — мусили переїхати, бо
  `documents.ts` ловить їх через `instanceof`) винесені в `src/lib/documents/recalc.ts`
  без директиви `"use server"`.
  **Перевірено незалежним скриптом**: 72 експортовані server actions, без перевірки
  сесії — рівно 3, усі в `auth.ts` (`loginWithPassword`, `sendMagicLink`, `logout`),
  і це за задумом. Діра закрита.
- [x] **5.2** ✅ У `finalize.ts` recalc, `validateFinalizable`, admin-override warnings і
  `commissionFields` перенесені всередину `$transaction`; `recalcDocument(document.id, tx)`.
  Агент пішов трохи далі за завдання і **перечитує** `companyId`/`items`/`lines` усередині
  транзакції — інакше перенесений recalc судив би за застарілим документом. Правильно.
- [x] **5.3** ✅ Форма guard'а: `assertStillDraft(tx, documentId)` робить
  `updateMany({ where: { id, status: "DRAFT" }, data: { status: "DRAFT" } })` і кидає
  `NotDraftError`, якщо `count !== 1`. Це **запис, а не читання** — свідомо: він бере
  блокування рядка і тому упорядковується проти власного guarded-`updateMany` у
  `finalizeDocument`, замість того щоб обидві сторони прочитали DRAFT і поїхали далі.
  Застосовано до всіх 13 інтерактивних транзакцій + `reorderItems`.
  Однооператорні записи (`deleteDraft`, `setDocumentClient`, `setItemShowImage`,
  `setValidityDays` тощо) guard'а не потребують — вони вкрутили `status: "DRAFT"` прямо
  у власний `where` і атомарні за побудовою.
  Зміна поведінки, варта згадки: `reorderItems` тепер оновлює `updatedAt` документа.
- [x] **5.4** ✅ `writeItemOptions` — `createMany` замість циклу (id створених рядків ніде
  не читаються). `applyScreenSideToQuote` **свідомо не змінено**: там `update`, а не
  `create`, і кожен рядок отримує власний JSON, змерджений з його ж `productionSpec` —
  `createMany` не застосовний, `updateMany` не вміє писати різні дані по рядках.
- [x] **5.5** ✅ Міграція `prisma/migrations/z30_query_indexes/`, 9 індексів. Дві поправки
  до аудиту, обидві обґрунтовані:
  - `DocumentLine(refId, kind)`, а **не** `(kind, refId)` — `refId` майже унікальний cuid,
    `kind` має три значення; kind-first сканував би третину таблиці й узагалі не обслужив
    би kind-less фільтр у `actions/catalog.ts:308`.
  - `CatalogVisibility.seriesId/productId` **відхилено**: усі читачі фільтрують лише за
    `userId`, який уже є лівим префіксом `@@unique([userId, seriesId, productId])`.
  - Аудит натомість **пропустив** `OptionConflictGroupMember(optionId)` — unique там
    `(groupId, optionId)`, а лукап іде по одному `optionId` на кожен рендер редактора опцій.
  SQL згенеровано через `prisma migrate diff --from-schema … --to-schema … --script`
  (без БД), тому він гарантовано збігається зі схемою — саме це перевіряє крок CI.
  Звичайний `CREATE INDEX`, не `CONCURRENTLY`: `migrate deploy` загортає міграцію в
  транзакцію, де `CONCURRENTLY` впав би, а таблиці малі.
- [x] **5.6** ✅ `dotenv` додано ще у Фазі 1.
- [x] **5.7** Прибрано дублікат, що виник через занадто вузьке ТЗ агента: він скопіював
  `getCommissionTiers` у `recalc.ts` як приватний `readCommissionTiers`, бо
  `queries/settings.ts` не входив у його список дозволених файлів. Замість копії
  `getCommissionTiers` отримав необов'язковий параметр `client: SettingReader = db`,
  копія видалена. Урок на майбутнє: перелік дозволених файлів має покривати весь
  природний обсяг зміни, інакше агент чесно виконає ТЗ ціною дублювання.

---

## Баги, знайдені ручним тестуванням 2026-09-05 (3 агенти)

Гейти після виправлень: lint ✅, typecheck ✅, `tsc -p tests` ✅, **44 файли / 1330 тестів** ✅,
`next build` ✅. Перевірено ще й наживо в браузері на документі `cmtnv9emb...`.

### Баг 1 — `Invalid input: expected object, received undefined` у production spec

**Не регресія.** `validation/production-spec.ts` сьогодні взагалі не мінявся;
у `actions/production.ts` діф лише механічний (`_shared.ts`, `revalidateDocument`);
у редакторі — один рядок імпорту.

**Корінь:** у редактора немає кнопки Save — кожен контрол робить
`save({ ...draft, поле: значення })`. На позиції, де `productionSpec` ще `null`, `draft`
це `{}`, тож **перше** торкнуте поле летить саме. А `mSeriesSpecSchema` вимагав і
`knifeSize`, і `drills` — звідси «expected object, received undefined» про відсутній
`drills`. `fabricProSpecSchema` мав ту саму латентну ваду через `travelPlatform`.

**Другий дефект на тому ж шляху:** галочка «Drills required» слала
`{ required: true, detail: "" }`, що `drillsSchema` відкидає — тобто її не можна було
поставити навіть на повній специфікації.

**Рішення — схема приймає часткові дані, не редактор шле повні.** Повної M-Series
специфікації просто не існує, поки менеджер не обрав розмір ножа; будь-яке «слати все»
означало б **вигадати** значення. Гірше: дефолт `drills: { required: false }` був би
брехнею цеху — `missingKeys` прочитав би це як «запитано й відповіли», і кнопка
завантаження розблокувалась би на питання, яке клієнту не ставили. Повнота вже має
власника: `FormSpec.requires` + `missingKeys`. Тож `knifeSize`, `drills`, `travelPlatform`
стали `.optional()` — форма при наявності досі валідується.
Виняток — drills: цей об'єкт **можна** доукомплектувати перед відправкою, тож refine
лишився, а редактор тримає галочку в локальному стані й пише обидві половини по blur.

### Баг 2 — податок 0 при GST 10% у налаштуваннях

**Не регресія** — рядки з `taxRate` у `HEAD` побайтово ті самі, що тепер у
`recalc.ts:211` і `lifecycle.ts:46-47`.

**Але й не той баг, що здавався.** На документі, який ти дав як референс, банер прямо
каже **«Ex Works — no GST applicable»**. Тобто нуль там навмисний і підписаний.
`EX_WORKS` обнуляє ставку за задумом.

**Втім знайшлася справжня вада поруч:** `Document.taxRate` — знімок, який пише **лише**
`createDraft`. `updateRegion` нікуди його не поширює, і **жоден інший код у застосунку
цю колонку не пише**. Чернетка, створена до налаштування GST, лишалась із нулем назавжди —
жодне редагування, збереження чи фіналізація її б не зрушили.

Новий `src/lib/documents/tax.ts`, `resolveDocumentTax`: **DRAFT перечитує** ставку регіону
при кожному перерахунку, **FINAL заморожений** — так само, як уже поводяться комісія і
validityDays. Мітка й ставка їдуть разом, тож `GST 10%` не може стати міткою одного
регіону поруч із числом іншого. Регіон уже приєднаний для дискаунт-капів — **зайвого
запиту немає**. `finalizeDocument` робить recalc усередині транзакції, поки статус ще
DRAFT, тому **квоту неможливо випустити зі старою ставкою**.

### Баг 3 — `$0` у збірних товарів

Фіча існувала з учора (`9561dcd`), але вмикалась лише за наявності опцій — Service,
у якого опцій нема, провалювався крізь неї.

**Факт із даних:** і `EL-2020`, і `SERVICE` мають у каталозі **літеральний `0`**, не null.
Каталог розрізняє: 12 продуктів мають `price: null` → `needsReview: true` («потрібна ціна»,
не «безкоштовно»). **Але цей сигнал не доживає до документа** — `Price.needsReview` ніде
не знімкується на `DocumentItem`. Агент не став вигадувати евристику, а зробив правило
безпечним за цієї неоднозначності, додавши умову на **сплачену** ціну.

Тепер два прапорці замість одного: `basePriceUnquoted` (каталожна 0 **і** сплачена 0) —
не друкувати гроші; `assembledFromOptions` (те саме **плюс** є опції) — прибрати рядок
цілком. Подарунок збережено: у ручно обнуленої машини `listPrice > 0`, тож жоден прапорець
не спрацьовує — рядок, «$0» і редактор ціни лишаються.

Побічно виправлено дві речі: дві таблиці одного PDF **суперечили одна одній** —
`baseRow` у quotation-data взагалі не дивився на `assembledFromOptions`; і латентний баг,
коли M3390 (каталожна null → `"0.00"`) з ручною ціною $85 000 губив і рядок, і ціну.

**Перевірено наживо:** EasyLoader → `Price: $21,623` без базового рядка; Service →
`Price: $300` з рядком опції, без `$0`.

- [ ] **Б3.1** Лишилось у схемі: доки `needsReview` (або явний прапорець продукту) не
  знімкується на `DocumentItem`, нецінований і несплачений M3390 читатиметься як збірний.
  Рендериться однаково — рядок без ціни, — але межу має вирішувати схема, не рендерер.

---

## Фази 6–8 — виконано 2026-09-05 (4 агенти паралельно)

Гейт: lint ✅, `typecheck` ✅, `tsc -p tests` ✅, **43 файли / 1297 тестів**, двічі поспіль
однаково. 125 файлів у діфі.

### Фаза 6a — запити і маршрути

- **`cache()` + пастка з ключем.** `getDocumentForBuilder` приймає об'єкт `ScopeUser`, а
  React `cache` ключує аргументи **за ідентичністю** (WeakMap — перевірено в
  `node_modules/react/cjs/react.react-server.development.js:575`). Кожен `auth()` повертає
  свіжий `session.user`, тож пряме обгортання **не мемоїзувало б нічого**. Рішення:
  внутрішня `getDocumentForBuilderInScope(userId, role, id)` на примітивах, а експортована
  функція — тонка обгортка. Те саме для `getCompanyDetail`.
- Кешовано також `getQuoteValidityDays`, `getShowOptionIcons`, `getHiddenCatalogIds`,
  `listProductsBySeriesById`, `getProductDetailById`, `getOptionDetailById`, `getRegionAdmin`,
  `getUser`, `getConflictGroupDetail`, `getContentBlock`.
- **`getCommissionTiers`**: мемоїзовано лише шлях через `db`-singleton. Обгортання цілої
  функції теж було б безпечним (tx має іншу ідентичність), але розділення **проговорює
  інваріант у коді**, а не спирається на цю деталь. Перевірено й час життя мемо: він живе
  на Flight-request, тож дедуплікує `generateMetadata` проти тіла сторінки, але в server
  action є інертним — збереження налаштування не отримає власне до-записове значення.
- **Кількість запитів на сторінці білдера: `32 + 2K` → `11 + 2K`** (при 8 серіях),
  глибина хвиль ~6 → ~3.
- **N+1 у пікері** згорнуто в один `series.findMany`. Свідомо `series.findMany`, а не
  `product.findMany`: серія без видимих продуктів мусить лишитись у списку з `products: []`,
  а запит із коренем у продукті її б викинув.
- Додано `app/(app)/error.tsx`, `not-found.tsx`, `documents/[documentId]/loading.tsx`.

### Фаза 6b — вага клієнтського бандла

- `next/dynamic({ ssr: false })` для редактора; у репозиторії не було **жодного**
  `next/dynamic` до цього. Скелет відтворює box model точно, тож підміна — перемальовка,
  а не reflow.
- **Barrel розділено**: `@/components/ui-kit` лишився server-safe, клієнтське поїхало в
  `@/components/ui-kit/client`. Оновлено 32 файли в `src/components/**`.
  `ConfirmProvider`/`ToastProvider` тимчасово реекспортуються з головного barrel — їх
  імпортує `src/app/(app)/layout.tsx`, який був поза межами агента (див. 6.9).
  `PhoneField` — саме той, що тягнув `i18n-iso-countries` — виїхав чисто.
- `i18n-iso-countries` більше не в клієнті: згенерований `src/lib/country-names.ts` (250
  записів), за тим самим зразком, що вже застосований для телефонних кодів. **Доказ
  еквівалентності**: перезібрано `getNames("en", {select:"official"})`, відсортовано
  `localeCompare`, `JSON.stringify` збігається побайтово.
- **XSS: агент правильно НЕ виконав частину завдання.** `notes-section.tsx` робить
  `dangerouslySetInnerHTML={{ __html: renderStoredRichText(notes) }}` над сирим значенням
  колонки, яке може бути старшим за allowlist на записі. Прибрати там санітизацію означало
  б пустити збережений `<script>`/`onerror=` зі старого рядка просто в DOM. Правильне
  місце — санітизувати на сервері й передавати готовий HTML (див. 6.9).

### Фаза 7 — дедуплікація дій

- `src/lib/actions/_shared.ts` (без директиви): прибрано **11 копій `ActionResult`**,
  7 × `NOT_FOUND_ERROR`, 2 × `CODE_EXISTS_ERROR`, 10 × `flattenZodError` (~90 рядків).
  Кожен модуль реекспортує `ActionResult` під старим ім'ям, тож жоден імпорт у компонентах
  не змінився.
- `src/lib/revalidate.ts`: 19 хелперів, усі **89** викликів переведено; `grep revalidatePath src/`
  тепер знаходить лише сам `revalidate.ts`. Механічний перерахунок шляхів дає рівно 89 —
  множина не змінилась. Бандлити все підряд агент відмовився свідомо: це змусило б
  `setConflictGroupMembers` і `setCatalogVisibility` реваліду вати сторінки, яких вони не чіпають.
- **`withDraftMutation` не робили** — і це правильно. Обгортка мусила б володіти створенням
  транзакції, мапінгом `NotDraftError`, `NegativeSubtotalError` **і** `ConcessionCapError`,
  а останні різняться від дії до дії (десь `warning`, у `setItemDiscount` власна логіка
  капів). Саме там однорідність і розсипається. Плюс шар без тестів і guard'и, покладені
  годину тому.

### Фаза 8 — тести

| | до | після |
|---|---|---|
| файли | 52 | **43** |
| тести | 1249 | **1297** |
| LOC | ~11 750 | **11 177** |
| десять `*-validation` | 2 817 | **2 089** |

Тестів **побільшало**, бо рядок `test.each` — це один тест: `it()`, що крутив цикл по
чотирьох входах, став чотирма тестами. Жодного кейса не втрачено.
`tests/helpers/fixtures.ts` (193 LOC) і `tests/helpers/schema.ts` (70 LOC). Наративні `it()`
збережені там, де вони документують правило: відкидання `javascript:`-URL, guard останнього
адміна, коерція чекбоксів.
`validityDaysSchema` **свідомо не злито** з `quoteValidityDaysSchema`: вони дають різний
текст помилки користувачеві, і злиття мовчки переписало б копію у формі документа. Натомість
винесено спільне *правило* — `validityDayCountSchema(messages?)`.

### Знайдено побіжно (не виправляли)

- [ ] **6.9** `src/app/(app)/documents/[documentId]/page.tsx`: санітизувати нотатки на
  сервері й передавати готовий HTML, щоб `notes-section.tsx` перестав тягнути DOMPurify
  у клієнт. Поки що санітизація там **потрібна** — не чіпати без цієї заміни.
- [ ] **6.10** `src/app/(app)/layout.tsx:3` → імпортувати провайдери з
  `@/components/ui-kit/client`, після чого прибрати реекспорт із головного barrel.
- [ ] **6.11** Ймовірна давня бага: `updateProductImage` (`actions/catalog.ts`) реваліду є
  `/catalog/{seriesId}/{productId}` і `/catalog/{seriesId}`, але **не** `/catalog`. Картка
  серії на індексі падає назад на зображення продукту (`getSeriesFallbackImageUrl`), тож
  зміна фото продукту може лишити індекс несвіжим. Те саме, з меншою впевненістю, в
  `upsertPrice`. Перевірити вручну, потім виправити.
- [ ] **6.12** `i18n-iso-countries` тепер узагалі не імпортується — кандидат на видалення
  з `package.json` (перевірити ще раз після 6.9).

---

## Фаза 6 — вихідний перелік (для довідки)

- [ ] **6.1** React `cache()`: `getDocumentForBuilder`, `getQuoteValidityDays`, `getCommissionTiers`, `getHiddenCatalogIds`, `getCompany*`, `getSeries*`, усі per-id getter'и, що викликаються з `generateMetadata` і page.
- [ ] **6.2** `documents/[documentId]/page.tsx`: `getHiddenCatalogIds` у перший `Promise.all`; `listCompatibleOptions` паралельно до batch'у.
- [ ] **6.3** `getItemPickerCatalog` → один `product.findMany({ include: { series: true, prices: { where: { region: { code } } } } })` + `select` замість `include: { region: true }`.
- [ ] **6.4** `next/dynamic(() => import("@/components/ui-kit/rich-text-editor"), { ssr: false })` у `notes-section`, `product-form`, `content-block-form`.
- [ ] **6.5** `ui-kit/index.ts` → server-safe; `ui-kit/client.ts` для `PhoneField`, `ToastProvider`, `ConfirmProvider`, `RichTextEditor`. Оновити 48 client-імпортерів (`sed` + перевірка `next build`).
- [ ] **6.6** `lib/countries.ts`: прибрати top-level `registerLocale`; клієнту — статичний масив `{ code, name }` (згенерувати скриптом у `src/lib/countries-data.ts`) або prop із сервера.
- [ ] **6.7** `lib/rich-text.ts`: `toEditorHtml` / `renderMarkdown` у DOMPurify-free модуль; sanitize лише server-side. (Побічно: −40 % import-часу тестів.)
- [ ] **6.8** `app/(app)/error.tsx`, `not-found.tsx`; `documents/[documentId]/loading.tsx`.

---

## Фаза 7 — Дедуплікація коду (3–4 PR, ~2 дні)

- [ ] **7.1** `src/lib/actions/_shared.ts`: `ActionResult`, `NOT_FOUND_ERROR`, `FORBIDDEN_ERROR`, `flattenZodError`, `withDraftMutation(itemId, role, fn)`. Видалити 12 копій.
- [ ] **7.2** `src/lib/revalidate.ts`: `revalidateDocument(id)`, `revalidateCompany(id)`, `revalidateCatalog(seriesId?)`, … Замінити 89 викликів.
- [ ] **7.3** `src/lib/documents/engine-input.ts`: `buildEngineInput(document, optionRows, tiers)`; Decimal → `.toString()`. Використати в `actions/documents.ts:230`, `queries/documents.ts:540`.
- [ ] **7.4** `validation/`: один `regionCodeSchema` (експорт з `regions.ts`), один `validityDaysSchema`. Видалити дубль-тести.
- [ ] **7.5** `pricing.ts`: винести `formatPct/concessionCapMessage/markupCapMessage` у `lib/pricing-messages.ts`; engine без імпортів.
- [ ] **7.6** Спільний `identityResolver` (`lib/sheet-identity.ts`).
- [ ] **7.7** `lib/upload-client.ts` для 3 raw `fetch("/api/uploads")`; спільний `ReorderList` для `items-list` / `product-reorder-list`.

---

## Фаза 8 — Тести: структура (2–3 PR, ~1 день)

- [ ] **8.1** `tests/helpers/fixtures.ts` (`baseItem`, `baseDoc`, `baseCompany`, `baseQuotationData`); переключити sheet-data, item-breakdown, quotation-data, pdf, finalize-validation, catalog-visibility.
- [ ] **8.2** `tests/helpers/schema.ts` (`expectValid`, `expectInvalid`, `cases`); конвертувати 10 `*-validation` у `test.each`. Наративні `it()` лишити для security/business-правил (website XSS, last-admin, checkbox coercion).
- [ ] **8.3** Злиття: discounts→pricing, item-breakdown→sheet-data, phone→phone-regions, numbering→format, roles→settings-nav, cell-ref→xlsx-patch, support→support-message-email, validity→documents-validation, us-prices→seed-mapping.
- [x] **8.4** (2026-09-06, у межах `docs/plans/2026-09-05-catalog-identity-and-cleanup.md` 4.2) `tests/catalog.test.ts` переписано як інваріанти над `catalog.json` (унікальні коди, правило символів v2, явні `kind`/`role`, null price ⇒ needsReview, по одній опції на EL-роль на ширину, компат тільки на існуючі ряди); назву файлу залишено. Literal counts/prices зведено до кількох spot-checks проти прайс-листа; X↔M порівняння знято — X тепер без AU-ціни за рішенням власника.
- [ ] **8.5** Підпапки за `src/lib`: `pricing/`, `sheet/`, `validation/`, `catalog/`, `production-forms/`, `text/`, `email/`, `misc/`.
- [ ] **8.6** Ціль: ~38 файлів, ~8.3k LOC, ~1150 тестів, ≤5 с.

---

## Фаза 9 — виконано 2026-09-05 (4 агенти паралельно)

Гейти: lint ✅, typecheck ✅, `tsc -p tests` ✅, **43 файли / 1297 тестів** ✅,
**`next build` ✅**. 151 файл у діфі.

### Розміри до / після

| Файл | Було | Стало |
|---|---:|---:|
| `src/lib/actions/documents.ts` | 1747 | **49** (барель) + 6 модулів |
| `src/lib/actions/catalog.ts` | 632 | **54** (барель) + 7 модулів |
| `src/lib/queries/documents.ts` | 949 | **16** (барель) + 4 модулі |
| `src/components/sheet/quotation-sheet.tsx` | 1231 | **101** + 12 секцій + `sheet-css.ts` |
| `src/components/builder/client-section.tsx` | 742 | **479** (−263) |
| `documents/[documentId]/page.tsx` | 437 | **402**, і 21 імпорт дій → 0 |

### Пастка `"use server"`, на яку наступили обидва агенти незалежно

Барель із директивою `"use server"` **не працює**: директива реєструє функції, які модуль
*оголошує*, а чистий реекспорт не оголошує жодної. `next build` відкидає його —
`Only async functions are allowed to be exported in a "use server" file` /
`The module has no exports at all`. Рішення: **барель без директиви**, кожен підмодуль зі
своєю. Записано в шапках обох барелів, щоб наступний не наступив утретє.

### 9.1 / 9.3 — розбиття документів

`documents/{lifecycle,items,options,lines,pricing,presentation}.ts` + `_internal.ts` без
директиви (`assertStillDraft`, `NotDraftError`, `mapDraftWriteError`). Одна не-механічна
зміна: ідентичний 4-гілковий `catch`, повторений **12 разів**, став
`return mapDraftWriteError(error)`.
Запити: `documents-list` (59), `documents-builder` (668), `documents-forms` (35),
`documents-pickers` (262). Розділення `getDocumentForBuilder` → кешований
`getDocumentForBuilderInScope` перенесено цілим, разом із поясненням.

### 9.2 — розбиття каталогу

`catalog/{products,options,images,prices,compatibility,conflict-groups}.ts` + `_internal.ts`.
Набір експортованих імен звірено з `HEAD` — 18 імен, побайтово ідентично.

### 9.4 — форми клієнта

Нові `clients/company-fields.tsx` (281) і `contact-fields.tsx` (122). Ключ до розділення —
проп `named`: сторінка `/clients` шле FormData і потребує атрибутів `name`, а панель у
білдері тримає стан і кличе JSON-дію. Спільні **поля**, не механіка сабміту.
Свідома зміна правила, задокументована: `required` підсвічує лейбл на обох екранах, але
HTML-атрибут `required` виставляється лише при `named` — панель білдера ніколи не
сабмітить, тож інпути назавжди лишались би `:invalid`.
Контрольовані форми: обрано контрольований стан, **не** `key`-remount — remount *викидає*
введене, тобто це і є та бага, а не її ліки. У `option-form` `sortOrder` тримається рядком:
`Number("")` це `0`, тож числовий стан перетворив би очищене поле на видимий «0».

### 9.6 — PDF

- `fileImageResolver` більше не читає диск синхронно. Двофазно: синхронна розмітка
  (`pq-pdf-image:<uuid>`), потім асинхронний прохід по відрендереному рядку. Другий прохід
  дає те, чого мапа до рендеру дати не може — **роль** зображення з класу `<img>`, а саме
  вона обирає ширину.
- Похідні за роллю: іконки опцій 24px→128, мініатюри 60px→256, аватар→256, лого→512.
  **Hero і фото машини свідомо лишились оригіналами**: вони `width: 100%` у боксі ~680px,
  а найбільша похідна в застосунку — 512px, тобто *вужча за бокс*. Похідна тут візуально
  розмила б фото, порушивши «без візуальних змін». Щоб їх теж стиснути, треба спершу
  розширити `DERIVATIVE_WIDTHS` до 1024 — окреме рішення.
- Обмежувач конкурентності: 2 одночасні конверсії, черга 6, далі 502. Обидва маршрути вже
  мапили throw у 502. Перевірено: 100 одночасних викликів → 8 прийнято, 92 відмовлено
  миттєво, гейт порожній після.
- **Доказ побайтової ідентичності HTML**: 4 фікстури (максимальна — watermark, лого, hero,
  аватар, дві секції машин, кредитний рядок, від'ємний рядок, terms, RSP, банк, підписи),
  95 463 символи, `cmp` чисто, md5 `0cc2f82983ccbc23f65551431e2f4d3f` з обох боків.

### 9.5 — перейменування міграцій на timestamp: **скасовано**

Вимагає правити рядки в таблиці `_prisma_migrations` на проді — тобто ризик зламати деплой
заради косметики й конвенцій `migrate dev`. Префікс `z` ламається аж на `z100`, зараз `z30`:
запас у 70 міграцій. Повернутись, якщо колись знадобиться `migrate dev` із генерацією імен.

### 9.7 — пагінація `listDocuments`/`listCompanies`: відкладено

Це не рефакторинг, а фіча: потрібні контроли пагінації в UI і рішення про розмір сторінки
та поведінку пошуку. Виносити в окрему задачу з дизайном.

### Знайдено побіжно (не виправляли)

- [ ] **9.9** `deleteDraft` типізований `Promise<ActionResult>`, але всі успішні шляхи
  закінчуються `redirect()` — оголошена успішна форма недосяжна.
- [ ] **9.10** `setEasyLoaderLayout` пише опції і спеку **двома окремими операціями**:
  падіння між ними лишає ціновані опції збереженими проти старого layout. Коментар там
  міркує лише про зворотний порядок.
- [ ] **9.11** `parseHeroImageUrl` — свідомо третя копія `parseImageUrl` (catalog, regions).
  Після розбиття каталогу в неї з'явився очевидний дім: `catalog/_internal.ts`.
- [x] **6.11** Бага з несвіжим індексом каталогу **підтверджена**: `listSeriesWithCounts`
  бере `s.imageUrl ?? s.products[0]?.imageUrl`, тож зміна фото продукту змінює картку серії
  на `/catalog`. Додано `revalidateCatalog()` у `updateProductImage`.
  `upsertPrice` перевірено й лишено: індекс не показує нічого цінового.
- [x] **6.12** `i18n-iso-countries` видалено з `package.json` (нуль імпортів), разом із його
  єдиною транзитивною залежністю `diacritics`.

---

## Фаза 9 — вихідний перелік (для довідки)

- [ ] **9.1** `actions/documents.ts` → `actions/documents/{lifecycle,items,options,lines,pricing,presentation}.ts`.
- [ ] **9.2** `actions/catalog.ts` → `products / options / prices / compat / conflict-groups`.
- [ ] **9.3** `queries/documents.ts` → `documents-builder.ts` / `documents-list.ts` / `pickers.ts`.
- [ ] **9.4** `client-section.tsx` → `CompanyFields` / `ContactFields` спільні з `clients/`; прибрати prop-drilling actions (імпорт у місці виклику); `region-form`, `user-form`, `option-form` контрольовані.
- [ ] **9.5** Міграції → timestamp-імена (скрипт перейменування папок + `UPDATE _prisma_migrations SET migration_name`); data-fix'и з `seed.ts:133-250` → одноразові міграції.
- [ ] **9.6** PDF: derivatives замість оригіналів, `fs.promises`, ліміт конкурентності (p-limit 2); `quotation-sheet.tsx` → `sheet/sections/*.tsx` + `sheet.css.ts`.
- [ ] **9.7** Пагінація `listDocuments`/`listCompanies`; server-side пошук клієнтів у builder.
- [ ] **9.8** `components/ui/button.tsx` → `ui-kit/`; `components.json` aliases → `ui-kit`.

---

## Рішення власника (2026-09-04)

> «Важлива швидкість деплою, а не складність розробки.»

Отже: GHCR схвалено, Фаза 2 йде повним обсягом, а не half-measures. Компроміси на кшталт
«лишити збірку на VPS, але з кешем» не розглядаємо. Там, де вибір між простішим
конфігом і швидшим деплоєм — беремо швидший.

## Що зробити руками (Фази 1–3, один пуш)

Власник вирішив не ганяти CI заради проміжних перевірок (кожен run коштує 7–15 хв),
тому Фази 1, 2 і 3 їдуть одним пушем. Локально перевірено все, що можна перевірити
без GitHub: три `docker build --target`, вміст `tools`, `npm ci`, typecheck, 1249 тестів,
валідність YAML обох файлів.

1. **До пушу — `docker login ghcr.io` на VPS** (крок 2.5; без нього перший деплой
   впаде на `docker compose pull`).

   Спершу створити токен на GitHub — **classic**, не fine-grained (GHCR інші не приймає),
   з єдиним скоупом `read:packages`. Готова форма:
   <https://github.com/settings/tokens/new?scopes=read:packages&description=pathquote-vps-pull>

   Потім на VPS вставити його у прихований prompt:

   ```bash
   read -rs GHCR_TOKEN && echo
   echo "$GHCR_TOKEN" | docker login ghcr.io -u hottabov --password-stdin
   unset GHCR_TOKEN
   ```

   Очікується `Login Succeeded`. Деталі й діагностика — `docs/runbook.md` §1 крок 3.

2. **Пуш у `main`.** Перший run буде найповільніший: кеш GHA порожній, і VPS тягне
   обидва образи цілком. Другий run покаже реальну усталену швидкість — саме його
   цифри й варто записувати.

3. **Записати часи** обох прогонів: `ci` / `build` / `deploy` + **загальний час workflow**
   → таблиця Фази 1.

4. **Перевірити після деплою:**

   ```bash
   cd /opt/pathquote
   docker compose ps                                   # app healthy, тег = sha коміту
   curl -fsS http://127.0.0.1:3010/api/health          # ok + schemaOk
   docker compose run --rm tools npm run db:verify-seed
   docker compose exec app ls prisma 2>&1 | head       # для кроку 2.9
   ```

5. **Перевірити rollback** (поки є на що відкочуватись і поки це безпечно —
   перед першою міграцією, що ламає сумісність):

   ```bash
   TAG=<попередній sha> docker compose up -d app && curl -fsS http://127.0.0.1:3010/api/health
   TAG=<новий sha> docker compose up -d app
   ```

### Що змінилось у Фазах 2–3 (для рев'ю перед пушем)

| Файл | Зміна |
|---|---|
| `.github/workflows/deploy.yml` | `verify-db` злито в `ci`; доданий `migrate diff --exit-code`; новий job `build` (GHCR, кеш GHA); `deploy` тепер pull-only |
| `docker-compose.yml` | `image:` для `app` і `tools` з `${TAG:-latest}`; `build:` залишено для локальної роботи |
| `scripts/verify-seed.ts` | новий; замінює 60 рядків inline CJS у YAML, виводить усі очікувані числа з `seed-lib.ts` + `catalog.json` |
| `package.json` | новий скрипт `db:verify-seed` |
| `docs/runbook.md` | §1 крок 3 — GHCR login; новий §2b — що робить деплой + rollback; перенумеровано кроки §1 |

## Що зробити руками (Фаза 1, вже виконано)

Пройдено: `npm ci` + typecheck + 1249 тестів ✅; `docker build --target build` ✅ (13.5 с);
`--target tools` ❌ → баг знайдено і виправлено (1.6c). Тонкий `tools` на VPS ще не
перевірено — крок 3 нижче виконувався зі **старим** образом, бо код не запушений.

1. **Перезапустити локальну збірку після фікса** — мають пройти всі три цілі:

   ```bash
   cd ~/Documents/"PF Invoice"
   docker build --target build -t pq-build-check . \
     && docker build --target tools -t pq-tools-check . \
     && docker build --target run   -t pq-run-check .
   ```

   Warning `SecretsUsedInArgOrEnv` має зникнути. Якщо якийсь `COPY` знову впаде на
   `not found` — це знову `.dockerignore`; надішли рядок помилки.

2. **Перевірити тонкий `tools` локально**, не чекаючи деплою (найризикованіша зміна;
   БД не потрібна — достатньо переконатися, що файли й бінарники на місці):

   ```bash
   docker run --rm pq-tools-check sh -c \
     'ls prisma/migrations | wc -l; ls scripts; node_modules/.bin/tsx --version; node_modules/.bin/prisma --version | head -2'
   ```

   Очікується: 31 міграція, перелік скриптів, версії tsx і prisma.

3. **Запушити в `main`.** Після зеленого деплою повторити операційні команди на VPS —
   тепер уже з новим образом:

   ```bash
   cd /opt/pathquote
   docker compose run --rm tools npx prisma migrate deploy   # "No pending migrations"
   docker compose run --rm tools npm run db:seed             # ідемпотентно
   ```

4. **Записати нові часи GHA** (`ci` / `verify-db` / `deploy` + **загальний час workflow**)
   у таблицю Фази 1.

5. **0.3b — виміряти seed.** Це єдина цифра, якої мені бракує, щоб вирішити обсяг Фази 3.
   Найшвидший спосіб — одна команда на VPS:

   ```bash
   cd /opt/pathquote && time docker compose run --rm tools npm run db:seed
   ```

   (альтернатива: розгорнути кроки job'а «Verify DB migrate + seed» у GHA і записати час
   `npm ci` / `Migrate` / `Seed (first run)` / `Seed (second run)` / count-check).

   **Чому це важливо:** якщо seed ≈ 3 хв, то два прогони — це 6 із 7m36s job'а, і Фаза 3
   мусить включати переписування `prisma/seed.ts` на `createMany` (крок 3.6) — єдина в
   плані зміна, що чіпає продакшн-дані. Якщо seed ≈ 20 с, винен другий `npm ci`, і 3.6
   не потрібен зовсім.

6. **GHCR — підтверджено** рішенням власника (див. вище). Мені знадобиться від тебе лише
   одне під час Фази 2: створити fine-grained PAT з правом `read:packages` і зробити
   `docker login ghcr.io` на VPS (одноразово). Токен нікуди не комітиться.

---

## Фаза 10 — Аудит залежностей (2026-09-04)

Запит власника: «залежностей на більше ніж гігабайт, чи всі вони потрібні?»

### Куди діваються 1231 MB

| MB | % | Група | Знімається? |
|---:|---:|---|---|
| 489 | 39.7 % | `next` + `@next/swc-*` (платформений бінарник) | ні |
| 228 | 18.5 % | **CLI `prisma`**: `@prisma/engines` 49, `@prisma/studio-core` 43, `@prisma/dev` 19, `@electric-sql/pglite` 24, `effect` 33, `elkjs` 7.7, `remeda` 5.2, `fast-check` | ні (транзитивні для CLI) |
| 80 | 6.5 % | `@prisma/client` + адаптер — **рантайм** | ні |
| 45 | 3.7 % | `vitest` + `vite` + `jsdom` | ні (dev) |
| 40 | 3.3 % | `lucide-react` | ні (tree-shaking на збірці) |
| **32** | **2.6 %** | **`shadcn` CLI-дерево**: `@modelcontextprotocol/sdk` 8.4, `ts-morph` 13, `hono` 2.7 | **так — див. 10.1** |
| 25 | 2.0 % | eslint-дерево | ні (dev) |
| 23 | 1.9 % | `typescript` | ні (dev) |
| 20 | 1.6 % | `sharp` + `libvips` | ні (`next/image`, ліниво в `image-derivatives.ts:112`) |
| 19 | 1.6 % | `@base-ui/react` | ні |
| 14 | 1.1 % | tailwind + lightningcss | ні |
| 13 | 1.1 % | `xlsx` + `codepage` | ні (dev, `scripts/extract-*`) |
| 8 | 0.7 % | tiptap | ні |
| 180 | 14.6 % | ~500 дрібних транзитивних | ні |

**`next` + CLI `prisma` — це 58 % усього.** Обидва невіддільні. «Гігабайт залежностей» тут
не ознака роздутого проєкту: 26 прямих prod-залежностей, і кожна, крім двох нижче,
реально імпортується.

### Головне: розмір `node_modules` більше не на критичному шляху

Після Фази 2 VPS нічого не збирає. `node_modules` тепер коштує лише:

- шар `deps` у GHA — кешується, перебудовується тільки при зміні `package-lock.json`;
- `npm ci` у job'і `ci` — кешується через `actions/setup-node` (`cache: npm`).

У рантайм-образ `node_modules` **не потрапляє**: `output: "standalone"` трасує лише
фактично використані файли. Тобто 228 MB CLI `prisma` не важать у продакшні нічого —
вони живуть у `tools`, який тягнеться раз і потім лежить у кеші шарів.

- [ ] **10.0** Підтвердити це числами: `docker image ls ghcr.io/hottabov/pathquote` —
  розміри `pathquote` і `pathquote-tools`. Саме `pathquote` — єдина цифра, що впливає
  на швидкість деплою.

### 10.1 Реально зайве: `shadcn` і `tw-animate-css` ✅ перевірено

`src/app/globals.css` імпортує три CSS-файли:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
```

`shadcn/tailwind.css` (16 KB, MIT) визначає утиліти `no-scrollbar`, `scroll-fade*`,
`shimmer*` і варіанти `data-open/closed/checked/unchecked/selected/disabled/active/`
`horizontal/vertical` + keyframes `accordion-*`. `tw-animate-css` дає `animate-in/out`,
`fade-*`, `zoom-*`, `slide-*`.

**Жодна з цих 22 утиліт не зустрічається в `src/` жодного разу.** (`duration-` і `ease-`,
які там є, — це ядро Tailwind, не `tw-animate-css`.)

- [x] **10.1** ✅ 2026-09-05. Обидва `@import` прибрані з `globals.css` (з коментарем, що
  саме перевірялось і за яких умов їх повертати), `shadcn` і `tw-animate-css` видалені з
  `package.json`. `package-lock.json`: **−3082 рядки, 809 пакетів замість ~1100**;
  `@modelcontextprotocol/sdk`, `ts-morph`, `hono` пішли разом із ними.
  Прямих залежностей: 25 prod + 14 dev.
  Лишились лише інертні згадки: два прозові коментарі в CSS і `$schema` у `components.json`.
  **Візуальна перевірка ще потрібна** — CSS не типізується, тож lint/tsc/тести тут не суддя.

**Виправлення запису Фази 1.** Там я написав, що `shadcn` — «CLI, який `src/` ніколи не
імпортує». Це було неправильно: він імпортується з `globals.css`. Переміщення в
`devDependencies` все одно коректне (так само, як `tailwindcss`, який теж лише
build-time і теж імпортується з CSS), і збірка проходить, бо `npm ci` ставить і dev —
але обґрунтування було хибним, і без кроку 10.1 пакет **не можна** просто видалити.

### 10.2 Що виглядало підозріло, але потрібне

| Пакет | Чому немає прямого `import` | Вердикт |
|---|---|---|
| `sharp` | ліниво: `await import("sharp")` у `image-derivatives.ts:112`, плюс `next/image` | лишити |
| `@tiptap/pm` | peer-залежність `@tiptap/react` | лишити |
| `tailwindcss`, `@tailwindcss/postcss` | через `postcss.config.mjs` і `@import` у CSS | лишити |
| `@types/*`, `typescript`, `tsx` | інструменти, не імпорти | лишити |
| `prisma` (у `dependencies`) | потрібен образу `tools` для `migrate deploy`; `postinstall` теж | лишити де є — переміщення в dev нічого не дасть, бо `tools` однаково ставить devDeps |
| `class-variance-authority` | лише `components/ui/button.tsx` | лишити, поки живий крок 9.8 |
| `xlsx` | лише `scripts/extract-*` — уже в devDeps | лишити |

### 10.4 `npm audit`: 9 «high» — розібрано поштучно (2026-09-05)

Після 10.1 залишилось 9 high (було 12). Жодна не є діючою вразливістю цього застосунку,
але дві заслуговують на нагляд. `npm audit` тут особливо неінформативний: для трьох із
дев'яти він пропонує «фікс», який насправді є **пониженням мажорної версії**.

| Пакет | Порада `npm audit` | Реальність |
|---|---|---|
| `prisma`, `@prisma/config`, `deepmerge-ts`, `mysql2` | «оновіть до `prisma@6.19.3`» | Це **даунгрейд** із 7.10.0. `mysql2` — драйвер MySQL, що тягнеться CLI `prisma` для інших провайдерів; тут `provider = "postgresql"`, тож він ніколи не завантажується. `deepmerge-ts` (stack exhaustion) спрацював би лише на зловмисному `prisma.config.ts`, який лежить у нашому ж репозиторії. Ігнорувати. |
| `next-auth`, `@auth/core` | «оновіть до `next-auth@1.12.1`» | Теж даунгрейд, із `5.0.0-beta.32`. Обидва позначені лише як транзитивні жертви `nodemailer` — див. рядок нижче. |
| **`nodemailer`** | фіксу немає | GHSA-p6gq-j5cr-w38f: message-level `raw` обходить `disableFileAccess`/`disableUrlAccess` → читання файлів і SSRF. **Перевірено: `raw` у коді не використовується жодного разу** (`src/lib/email/`, `src/auth.ts`), а тіла листів (magic link, support) конструюються на сервері й не містять вводу користувача в цій ролі. Не експлуатується. |
| **`xlsx`** | фіксу немає | Prototype pollution + ReDoS у SheetJS. Пакет імпортується лише у скриптах і тестах (станом на 2026-09-06: `scripts/lib/catalog-export.ts`, `scripts/export-catalog.ts`, `tests/catalog-export.test.ts`, `tests/production-forms-contract.test.ts`; Excel-екстрактори каталогу видалено). Це `devDependency`, він не потрапляє ні в застосунок, ні в образ, і працює на файлах, які ми самі кладемо в `RAW/`. Виробничі форми будує `src/lib/production-forms/xlsx-patch.ts` **на `fflate`**, не на цьому пакеті. |

- [ ] **10.4a** `nodemailer` 8.0.11 → 10.0.0 існує, але **заблокований**: `@auth/core`
  оголошує peer `nodemailer@"^7.0.7 || ^8.0.5"`. Підняти можна лише разом із next-auth,
  коли той випустить версію, що приймає 9/10. Поставити на радар, не форсувати —
  вразливий шлях у нас не задіяний, а зламати логін заради цього не варто.
- [ ] **10.4b** `xlsx` на npm покинутий (0.18.5, 2022). Актуальні версії SheetJS живуть
  на `cdn.sheetjs.com`. Мігрувати варто **не заради безпеки** (dev-only, довірений ввід),
  а щоб перестати тягнути мертвий пакет. Низький пріоритет.

Висновок: `npm audit --production` тут дав би точнішу картину, ніж повний прогін.
Жодного `npm audit fix --force` — три з дев'яти «фіксів» відкотили б мажорні версії.

### 10.3 Не робити

- Не викидати CLI `prisma` заради 228 MB — без нього немає ні міграцій, ні `generate`.
- Не намагатись «схуднути» `next` — 489 MB це переважно платформений бінарник SWC,
  і в Linux-образі ставиться рівно один варіант.
- Не робити `npm ci --omit=dev` для `tools`: там потрібні і `prisma`, і `tsx`.

## Порядок і залежності

> Переглянуто після baseline: `verify-db` (7m36s) виявився довшим за все інше, тому
> **Фаза 3 йде перед Фазою 2**.

```
0 → 1 → 3 → 2        (деплой; порядок 3 перед 2 — див. висновок Фази 0)
4                    (незалежно, будь-коли)
5 → 7.1 → 9.1        (recalc спершу, потім shared, потім split)
6.5 ← 6.4, 6.6       (barrel split перед dynamic/countries — інакше двічі правити імпорти)
7.4 → 8.2            (dedupe схем перед table-driven тестами)
8.1 → 8.3 → 8.5
```

## Критерії успіху

- push → healthy ≤ 5 хв при теплому кеші; VPS-крок ≤ 60 с; VPS CPU не використовується для збірки.
- `npm test` ≤ 5 с; `npm run typecheck` не тягне `tests/`.
- `grep -rn "export async function" src/lib/actions` — жодної функції без `requireSession/requireAdmin` на початку.
- `grep -rn "type ActionResult" src` — 1 результат.
- Жодного `include: { region: true }` у picker-запитах; `EXPLAIN` на `listDocuments` використовує індекс `updatedAt`.
