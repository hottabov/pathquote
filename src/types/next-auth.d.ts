import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

// NextAuth's own `NextAuthConfig` callbacks (and hence the `session`/`jwt`
// callback parameter types we use in src/auth.ts) are typed against
// `@auth/core`'s `Session`/`User`/`JWT` interfaces directly (imported from
// "@auth/core/types" and "@auth/core/jwt"), not through "next-auth"'s
// re-exports. Augment both the "next-auth" surface (for client-side
// `useSession`, etc.) and the underlying "@auth/core" modules so the
// callback parameter types pick up the extra fields.

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      regionId: string | null;
      /** Countries whose clients this user may read and edit; `"*"` is all of
       * them and `[]` is none. See `ScopeUser` in src/lib/scope.ts. */
      visibleCountries: string[];
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
    regionId?: string | null;
    visibleCountries?: string[];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid: string;
    role: Role;
    regionId: string | null;
    visibleCountries: string[];
    /** Epoch ms of the last DB revalidation of this token (see src/auth.ts jwt callback). */
    revalidatedAt: number;
  }
}

declare module "@auth/core/types" {
  interface Session {
    user: {
      id: string;
      role: Role;
      regionId: string | null;
      /** Countries whose clients this user may read and edit; `"*"` is all of
       * them and `[]` is none. See `ScopeUser` in src/lib/scope.ts. */
      visibleCountries: string[];
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
    regionId?: string | null;
    visibleCountries?: string[];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    uid: string;
    role: Role;
    regionId: string | null;
    visibleCountries: string[];
    /** Epoch ms of the last DB revalidation of this token (see src/auth.ts jwt callback). */
    revalidatedAt: number;
  }
}
