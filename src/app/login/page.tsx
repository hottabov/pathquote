import Image from "next/image";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { safeRelativeCallbackUrl } from "@/lib/auth/safe-callback-url";
import { LoginForm } from "./login-form";

type LoginPageProps = {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const rawCallbackUrl = Array.isArray(params.callbackUrl)
    ? params.callbackUrl[0]
    : params.callbackUrl;

  // Defense in depth: the server actions are the actual trust boundary and
  // re-validate this value themselves, since the hidden inputs are
  // client-controlled. This just avoids echoing an unsafe value into the form.
  const callbackUrl = safeRelativeCallbackUrl(rawCallbackUrl);

  // Someone who is already signed in has nothing to do here. Without this the
  // form rendered regardless, so any sign-in that happened to land on /login
  // looked exactly like a sign-in that had failed.
  const session = await auth();
  if (session?.user) redirect(callbackUrl);

  return (
    <div className="flex min-h-dvh flex-1 items-center justify-center bg-brand-dark px-4 py-12">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-lg sm:p-8">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Image
            src="/pathquote-logo.png"
            alt=""
            aria-hidden="true"
            width={512}
            height={512}
            priority
            className="size-14 rounded-xl object-cover shadow-sm"
          />
          <h1 className="text-2xl font-semibold text-brand-dark">PathQuote</h1>
        </div>
        <LoginForm callbackUrl={callbackUrl} />
      </div>
    </div>
  );
}
