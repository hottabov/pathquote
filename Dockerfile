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
# `npm run user:create`, the image importers). Built from `deps`, not from
# `build`: it needs the source and node_modules but never `.next`, and taking
# it from `build` used to drag the compiled app — and the build-time secret
# placeholders — into an image an operator runs by hand.
FROM node:22-alpine AS tools
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
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
# Taken from `tools` rather than `build`, which no longer holds the whole
# prisma/ directory. Kept byte-identical to the previous image for now;
# whether the runtime needs it at all is a Phase 2 question (Prisma 7 with a
# driver adapter inlines the schema into the generated client).
COPY --from=tools /app/prisma ./prisma
# Production forms are read from disk at request time; Next's standalone
# trace cannot include dynamically selected template filenames automatically.
COPY --from=build /app/src/lib/production-forms/templates ./src/lib/production-forms/templates
EXPOSE 3000
CMD ["node", "server.js"]
