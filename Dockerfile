FROM node:22-alpine AS deps
WORKDIR /app
# The `postinstall: prisma generate` script (added so a plain `npm ci` leaves a
# usable client — Prisma 7 dropped its own install hook) runs as part of
# `npm ci`, and it needs the schema and config to exist. Copying just those two
# files rather than the whole `prisma/` directory keeps this layer cached when
# migrations or seed data change, which is most of the time.
#
# `prisma generate` needs no DATABASE_URL here: the datasource block in
# schema.prisma carries only `provider`, and the connection string reaches
# Prisma at runtime through the driver adapter (src/lib/db.ts).
COPY package*.json prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci

# The runtime-only tree, for the `tools` image. `deps` above installs
# devDependencies as well, because `next build` needs them; `tools` never
# builds anything — it runs `prisma migrate`, `db:seed` and the operator
# scripts through tsx — so eslint, vitest, tailwind, typescript and their
# transitive trees are pure transfer cost on every deploy. The VPS pulls at
# ~500 KB/s, which is where that cost is actually paid.
#
# `tsx` and `dotenv` are in `dependencies`, not `devDependencies`, precisely
# so they survive `--omit=dev`: every operator script runs under tsx, and
# prisma.config.ts imports `dotenv/config` at load time. (dotenv also arrives
# transitively via prisma -> @prisma/config -> c12, but a direct import
# deserves a direct dependency rather than someone else's hoisting.)
#
# The `rm` shares this RUN deliberately. Deleting in a later layer leaves the
# files in the parent layer and saves nothing on the wire. `@next/swc-*` is
# the Rust compiler `next build` shells out to — on Alpine both the gnu and
# musl variants install, ~180 MB together — and nothing at runtime loads it:
# every `npm run` script in the tools image was checked against a tree built
# exactly this way.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN npm ci --omit=dev && rm -rf node_modules/@next/swc-*

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Explicit copies, not `COPY . .`. Every path listed here is a real input to
# `next build`; anything else that changes must not invalidate this layer.
#
# prisma/seed-lib.ts is copied even though nothing under src/ imports it,
# because tsconfig's include is `**/*.ts` — a build running with SKIP_TYPECHECK
# unset (a local `docker build`, say) compiles whatever .ts files are present,
# and this one is cheap to satisfy. It has no further dependencies of its own.
#
# There used to be a third copy here, prisma/seed-data/content-blocks.json,
# for src/lib/content-placeholders.ts. Both were removed by 271c6f1 ("refactor:
# retire ContentBlock"), which left this line behind pointing at a file no
# longer in the repository — so every image build failed at `COPY` until it was
# taken out. An explicit copy list is only safer than `COPY . .` while it is
# kept in step with what actually exists.
COPY package.json next.config.ts tsconfig.json postcss.config.mjs ./
COPY prisma/seed-lib.ts ./prisma/seed-lib.ts
COPY public ./public
COPY src ./src
# APP_VERSION lets the deploy stamp a git SHA onto the build; when it is empty
# next.config.ts falls back to package.json's version. See src/lib/app-version.ts.
ARG APP_VERSION=""
# CI (.github/workflows/deploy.yml, job `ci`) runs `tsc --noEmit` over the same
# tree before this image is ever built, and the deploy job only runs when that
# passed. Type-checking a second time inside `next build` is pure duplicated
# work on the VPS's CPU.
ENV NEXT_TELEMETRY_DISABLED=1 \
    SKIP_TYPECHECK=1
# `next build` statically imports route/proxy modules (including src/auth.ts
# -> src/lib/db.ts) to collect page data. That requires DATABASE_URL to be set
# to *something* syntactically valid (the Prisma driver adapter is lazy and
# doesn't connect at construction time) and AUTH_SECRET to be non-empty.
#
# They are set inline on this one RUN rather than as ARG or ENV so that no
# placeholder credential exists anywhere outside this command — not in a
# layer, not in `docker history`, not in a stage someone later runs by hand.
# Real values come from the container's env_file (see docker-compose.yml).
#
# No `prisma generate` here either: the deps stage already generated the
# client into node_modules/.prisma, which arrives with the COPY above.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    AUTH_SECRET="build-time-placeholder-not-used-at-runtime" \
    npm run build

# Migrations, seeding and the operator scripts (`npm run db:seed`,
# `npm run user:create`, the image importers). Built from `prod-deps`, not
# from `build`: it needs the source and node_modules but never `.next`, and
# taking it from `build` used to drag the compiled app — and the build-time
# secret placeholders — into an image an operator runs by hand. It took the
# full `deps` tree until the runtime-only one above existed.
FROM node:22-alpine AS tools
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json prisma.config.ts tsconfig.json ./
COPY prisma ./prisma
COPY scripts ./scripts
# scripts/import-industries.ts imports src/lib/validation/industries.
COPY src ./src
CMD ["node", "-e", "console.log('tools image: run prisma/seed/user commands via docker compose run tools ...')"]

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
# Only the schema. The rest of prisma/ is operator territory — migrations
# (the `tools` image applies them) and ~7 MB of seed-data product images —
# and nothing under src/ reads either at request time. The schema itself
# stays because it costs 40 KB and Prisma tooling expects to find it; with a
# driver adapter the generated client already carries its own copy.
COPY --from=tools /app/prisma/schema.prisma ./prisma/schema.prisma
# Production forms used to be read from disk at request time (xlsx
# templates under src/lib/production-forms/templates), which Next's
# standalone trace cannot include automatically -- hence a manual COPY here.
# 8ef58f0 ("replace legacy Excel production forms with TSX components")
# deleted the last of those workbooks, so the directory no longer exists and
# the COPY started failing the image build. Every production form is now a
# TSX component compiled into the app; nothing at runtime reads that path
# any more, so the copy is gone rather than fixed.
EXPOSE 3000
CMD ["node", "server.js"]
