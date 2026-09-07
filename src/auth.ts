import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import { createTransport } from "nodemailer";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { buildMagicLinkEmail } from "@/lib/email/magic-link";
import { toConfirmUrl } from "@/lib/email/magic-link-url";
import { resolveReplyTo } from "@/lib/email/reply-to";
import { verify } from "@node-rs/argon2";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

// P1xxx (connectivity/engine) and P2xxx (schema/query, e.g. P2022 "column
// does not exist") Prisma error codes indicate an infrastructure problem —
// not a bad login. Letting these fall into the same "no user found" path as
// a wrong password produces a confusing "Invalid credentials" UX for what is
// actually a broken deploy (see 2026-08-31 incident: migrations 4-7 not
// applied, User.phone missing, every login failed with P2022 silently
// swallowed here). Loudly logging and re-throwing lets it surface as a 500
// instead, and keeps it out of the timing-safe "no such user" branch below.
// Magic links are single-use and arrive by email; 15 minutes is long enough to
// switch to a mail client and back, short enough that a link sitting in an
// unattended inbox stops being a credential.
const MAGIC_LINK_MAX_AGE_SECONDS = 900;

function isPrismaInfraError(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && /^P[12]/.test(e.code)
  );
}

// A pre-computed, valid argon2id hash of a random, unused password. When no
// user is found (or the user has no passwordHash), we still run `verify`
// against this constant so the authorize() call takes roughly the same time
// whether or not the email exists — otherwise an attacker could enumerate
// registered emails by measuring response latency (DB lookup + hash miss vs.
// DB lookup + a full argon2 verify). This value is not a secret and is never
// used to authenticate anything.
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$gAonQQ7IRqomDRUI9GVvrQ$Uq/TgecqsuEP1TO9SpOsmCEytUT7/hAECjX2DEqflH4";

// How often (ms) an existing JWT is re-checked against the database in the
// `jwt` callback below. Bounds how long a deactivated/deleted user's
// already-issued session stays valid.
const REVALIDATE_INTERVAL_MS = 5 * 60 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  session: {
    strategy: "jwt",
    maxAge: 7 * 24 * 60 * 60, // 7 days
    updateAge: 60 * 60, // 1 hour
  },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        let user;
        try {
          user = await db.user.findUnique({ where: { email } });
        } catch (e) {
          if (isPrismaInfraError(e)) {
            console.error("[auth] infrastructure error in authorize() user lookup", e);
          }
          throw e;
        }
        const hashToVerify =
          user?.active && user.passwordHash ? user.passwordHash : DUMMY_PASSWORD_HASH;

        // Always run the argon2 verify, even for a nonexistent/inactive
        // user or one without a passwordHash, against the dummy hash above —
        // this keeps timing consistent regardless of which branch we took.
        let ok = false;
        try {
          ok = await verify(hashToVerify, password);
        } catch {
          // Malformed hash, decoding error, etc. — never let a throw here
          // leak information or crash the request; just fail closed.
          return null;
        }

        if (!user?.active || !user.passwordHash || !ok) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
    Nodemailer({
      server: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      },
      from: process.env.EMAIL_FROM,
      maxAge: MAGIC_LINK_MAX_AGE_SECONDS,
      // Overrides the Auth.js default template. Two reasons: it's branded
      // "Auth.js", and it has no Reply-To — our From address lives on the
      // Resend sending subdomain (noreply@q.pathfindercut.com) and accepts no
      // mail, so a reply would bounce into the void. EMAIL_REPLY_TO points at
      // a real, monitored Microsoft 365 mailbox.
      async sendVerificationRequest({ identifier, url, provider }) {
        const { subject, text, html, replyTo } = buildMagicLinkEmail({
          // Never the raw callback URL. `url` signs you in on GET, so the first
          // machine to fetch it wins — which is what happened on 2026-09-07,
          // when a link scanner consumed a token 24 seconds after send and 31
          // seconds before the mail reached the inbox. toConfirmUrl points the
          // link at an inert page whose button POSTs to that same callback.
          // See src/lib/email/magic-link-url.ts.
          url: toConfirmUrl(url),
          // A sign-in link has no document author, so this always resolves to
          // the shared inbox. Quote emails to clients pass the document's
          // author here instead — see src/lib/email/reply-to.ts.
          replyTo: resolveReplyTo(null, process.env.EMAIL_REPLY_TO),
          maxAgeMinutes: MAGIC_LINK_MAX_AGE_SECONDS / 60,
        });

        const result = await createTransport(provider.server).sendMail({
          to: identifier,
          from: provider.from,
          replyTo,
          subject,
          text,
          html,
        });

        const failed = [...(result.rejected ?? []), ...(result.pending ?? [])].filter(Boolean);
        if (failed.length) {
          throw new Error(`Email (${failed.join(", ")}) could not be sent`);
        }
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      // Only pre-created, active users may authenticate. The Credentials
      // provider's `authorize` above already enforces this, so this check
      // is only load-bearing for the magic-link (nodemailer) flow — it
      // must never create accounts on the fly. Auth.js runs this callback
      // *before* issuing a verification token or sending the email (see
      // @auth/core's sendToken), so an unknown/inactive email never gets a
      // link sent at all.
      if (!user.email) return false;
      const existing = await db.user.findUnique({ where: { email: user.email } });
      return !!existing?.active;
    },
    async jwt({ token, user }) {
      // `user` is only populated on the initial sign-in. Load the
      // authoritative role/region from the database at that point and
      // carry it in the token for subsequent requests.
      if (user?.email) {
        let dbUser;
        try {
          dbUser = await db.user.findUnique({ where: { email: user.email } });
        } catch (e) {
          if (isPrismaInfraError(e)) {
            console.error("[auth] infrastructure error in jwt() initial sign-in lookup", e);
          }
          // No existing token to fall back to on a fresh sign-in — nothing
          // safe to return but a failure.
          throw e;
        }
        if (!dbUser || !dbUser.active) return null;
        token.uid = dbUser.id;
        token.role = dbUser.role;
        token.regionId = dbUser.regionId;
        token.revalidatedAt = Date.now();
        return token;
      }

      // Subsequent invocation for an already-issued token: without this, a
      // user deactivated (or deleted) after signing in would keep a fully
      // valid session for up to `maxAge` (7 days), since the JWT is
      // self-contained and normally never touches the database again. Re-hit
      // the DB at most once per REVALIDATE_INTERVAL_MS to catch that case
      // and to keep role/regionId in sync with the source of truth, while
      // keeping the common case (a request within the interval) DB-free.
      const revalidatedAt = token.revalidatedAt ?? 0;
      if (Date.now() - revalidatedAt < REVALIDATE_INTERVAL_MS) {
        return token;
      }

      if (!token.uid) return null;

      let dbUser;
      try {
        dbUser = await db.user.findUnique({ where: { id: token.uid } });
      } catch (e) {
        if (isPrismaInfraError(e)) {
          // A DB/schema hiccup here must not silently log every active
          // session out — that's what turned the 2026-08-31 migration
          // incident into a total outage. Log loudly and keep the existing
          // token valid; `revalidatedAt` is deliberately left unchanged so
          // the very next request retries the DB lookup instead of waiting
          // out the full interval, so it recovers as soon as the
          // infrastructure problem is fixed.
          console.error("[auth] infrastructure error in jwt() revalidation lookup", e);
          return token;
        }
        throw e;
      }
      if (!dbUser || !dbUser.active) return null;

      token.role = dbUser.role;
      token.regionId = dbUser.regionId;
      token.revalidatedAt = Date.now();
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.uid;
        session.user.role = token.role;
        session.user.regionId = token.regionId;
      }
      return session;
    },
  },
});
