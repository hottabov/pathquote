import { NextResponse, type NextRequest } from "next/server";
import { handlers } from "@/auth";
import { CONFIRM_PATH } from "@/lib/email/magic-link-url";

export const POST = handlers.POST;

// A GET of the nodemailer callback used to be a complete sign-in: @auth/core
// consumes the token there, and @auth/prisma-adapter's `useVerificationToken`
// deletes the row before anything is validated. So the first machine to fetch
// the URL both burned the link and collected a session — which is what a
// Microsoft 365 link scanner did on 2026-09-07, 31 seconds before the mail
// reached the recipient.
//
// Emails have pointed at /login/confirm since that incident, but the route
// itself stayed live, and links sent before the change are still sitting in
// inboxes. Bouncing the GET to the confirm page makes it harmless: nothing is
// read, nothing is spent, and an old link picks up the new POST flow instead
// of dying in a scanner's fetch. The query string is carried over untouched —
// the token is compared byte-for-byte, so re-encoding it would break sign-in.
//
// Only this one provider and only GET. Credentials sign-in is POST, and there
// is no OAuth provider configured; if one is ever added, its callback is a GET
// and must fall through to `handlers.GET` exactly as everything else here does.
function isMagicLinkCallback(pathname: string): boolean {
  return pathname.endsWith("/callback/nodemailer");
}

export async function GET(request: NextRequest) {
  if (isMagicLinkCallback(request.nextUrl.pathname)) {
    const confirm = new URL(request.nextUrl);
    confirm.pathname = CONFIRM_PATH;
    return NextResponse.redirect(confirm);
  }
  return handlers.GET(request);
}
