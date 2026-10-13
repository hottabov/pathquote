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
      /** Whether Settings offers this user the ACT! sync section, and whether
       * its page and Sync now action will serve them. Not consulted for an
       * ADMIN or DEVELOPER, who get the section by role — see `canSeeActSync`
       * in src/lib/roles.ts. */
      actSyncVisible: boolean;
      /** Whether the quote builder shows this user "Your commission". Not
       * consulted for an ADMIN or DEVELOPER, who see it by role — see
       * `canSeeCommission` in src/lib/roles.ts. */
      commissionVisible: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
    regionId?: string | null;
    visibleCountries?: string[];
    actSyncVisible?: boolean;
    commissionVisible?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid: string;
    role: Role;
    regionId: string | null;
    visibleCountries: string[];
    actSyncVisible: boolean;
    commissionVisible: boolean;
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
      /** Whether Settings offers this user the ACT! sync section, and whether
       * its page and Sync now action will serve them. Not consulted for an
       * ADMIN or DEVELOPER, who get the section by role — see `canSeeActSync`
       * in src/lib/roles.ts. */
      actSyncVisible: boolean;
      /** Whether the quote builder shows this user "Your commission". Not
       * consulted for an ADMIN or DEVELOPER, who see it by role — see
       * `canSeeCommission` in src/lib/roles.ts. */
      commissionVisible: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    role?: Role;
    regionId?: string | null;
    visibleCountries?: string[];
    actSyncVisible?: boolean;
    commissionVisible?: boolean;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    uid: string;
    role: Role;
    regionId: string | null;
    visibleCountries: string[];
    actSyncVisible: boolean;
    commissionVisible: boolean;
    /** Epoch ms of the last DB revalidation of this token (see src/auth.ts jwt callback). */
    revalidatedAt: number;
  }
}
