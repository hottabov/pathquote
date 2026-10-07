import type { ActContact } from "@/lib/act/types";

// HTTP against the Act! Web API. Every judgement this integration makes lives
// in the pure modules beside this one; what is left here is transport, and it
// is deliberately dull.
//
// Three details of this API that cost time to discover, all verified against
// the live system (docs/act-integration-reference.md):
//
//   - The username is the Act! display name as shown in Manage Users --
//     "John Hollo", not "john". A wrong username and an unregistered database
//     name both return a bare 401 with no body, so they are indistinguishable
//     from the response alone.
//   - Response envelopes are not consistent. /api/contacts returns
//     { value: [...], Count: n }; /api/users and the metadata endpoints return
//     a bare array. Reading .value off a bare array yields nothing and looks
//     exactly like a permissions failure.
//   - Count is the size of the page, not a total.

export type ActClientConfig = {
  /** e.g. https://actapi.pathfindercut.com/act.web.api */
  baseUrl: string;
  database: string;
  username: string;
  password: string;
};

/** Tokens last 65 minutes; renew early rather than racing the boundary. */
const TOKEN_TTL_MS = 55 * 60 * 1000;

const PAGE_SIZE = 200;

export class ActApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ActApiError";
  }
}

export class ActClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: ActClientConfig) {}

  private async authorize(): Promise<string> {
    const credentials = Buffer.from(
      `${this.config.username}:${this.config.password}`,
    ).toString("base64");

    const response = await fetch(`${this.config.baseUrl}/authorize`, {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Act-Database-Name": this.config.database,
      },
    });

    const body = await response.text();
    if (!response.ok) {
      throw new ActApiError(
        `authorize failed (${response.status}). Check the username is the Act! display name, the database name, and that the account has the "Web API Access" permission -- a missing permission is 4032.`,
        response.status,
        body,
      );
    }

    this.token = body.replace(/^"|"$/g, "");
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return this.token;
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    return this.authorize();
  }

  /** One GET, with whatever token is current, result uninterpreted. */
  private async fetchOnce(path: string): Promise<Response> {
    const token = await this.getToken();
    return fetch(`${this.config.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Act-Database-Name": this.config.database,
      },
    });
  }

  private async parse(path: string, response: Response): Promise<unknown> {
    const body = await response.text();
    if (!response.ok) {
      throw new ActApiError(`GET ${path} failed (${response.status})`, response.status, body);
    }
    return body ? JSON.parse(body) : null;
  }

  /**
   * GET a path, re-authorising once if the token was rejected.
   *
   * Two explicit attempts rather than a loop. A `for` loop here needs a throw
   * after it to satisfy the compiler, that throw is unreachable, and its
   * message can therefore never print -- so the second 401 would surface as a
   * bare "failed (401)" while the useful sentence sat in dead code. This shape
   * has no unreachable branch and the diagnostic actually fires.
   */
  private async get(path: string): Promise<unknown> {
    const first = await this.fetchOnce(path);
    if (first.status !== 401) return this.parse(path, first);

    // Expired or revoked mid-run. Drop the cached token so the retry fetches a
    // fresh one.
    this.token = null;
    const second = await this.fetchOnce(path);
    if (second.status === 401) {
      throw new ActApiError(
        `GET ${path} failed: still 401 after re-authorising. The account may have lost its "Web API Access" permission, or the password was rotated.`,
        401,
        await second.text(),
      );
    }
    return this.parse(path, second);
  }

  /** Unwrap whichever envelope this endpoint happens to use. */
  private rows<T>(payload: unknown): T[] {
    if (Array.isArray(payload)) return payload as T[];
    if (payload && typeof payload === "object" && Array.isArray((payload as { value?: unknown }).value)) {
      return (payload as { value: T[] }).value;
    }
    return [];
  }

  /** The API version, and the Act! version behind it. Logged on every run so a
   * surprise upgrade shows up in our logs before it shows up as a bug. */
  async system(): Promise<{ apiVersion: string; sdkVersion: string }> {
    const payload = (await this.get("/api/system")) as {
      apiVersion?: string;
      sdkVersion?: string;
    };
    return {
      apiVersion: payload?.apiVersion ?? "unknown",
      sdkVersion: payload?.sdkVersion ?? "unknown",
    };
  }

  /**
   * Every contact edited since `since`, oldest first, a page at a time.
   *
   * Ordered by `edited` so a run interrupted halfway can resume from the last
   * record it stored rather than starting again. `$skip` rather than a keyset
   * cursor because the API offers no stable tiebreaker on equal timestamps;
   * at 12,000 records over ~60 pages the depth cost is irrelevant.
   */
  async *contactsEditedSince(since: Date | null): AsyncGenerator<ActContact[]> {
    let skip = 0;
    for (;;) {
      const params = new URLSearchParams({
        $top: String(PAGE_SIZE),
        $skip: String(skip),
        $orderby: "edited",
      });
      if (since) {
        // `ge`, not `gt`. The cursor is the newest `edited` this sync stored,
        // and a --limit run stops mid-stream: another record can carry that
        // same timestamp and never have been reached. `gt` would skip it
        // permanently. `ge` re-reads the boundary record instead, which
        // fill-only-empty turns into a no-op.
        params.set("$filter", `edited ge ${since.toISOString()}`);
      }

      const page = this.rows<ActContact>(await this.get(`/api/contacts?${params}`));
      if (page.length === 0) return;
      yield page;
      if (page.length < PAGE_SIZE) return;
      skip += PAGE_SIZE;
    }
  }
}

/** Build a client from the environment. Throws with the missing names rather
 * than failing later with an unhelpful 401. */
export function actClientFromEnv(): ActClient {
  const required = ["ACT_BASE", "ACT_DB", "ACT_USER", "ACT_PASS"] as const;
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`missing environment: ${missing.join(", ")}`);
  }
  return new ActClient({
    baseUrl: process.env.ACT_BASE!.replace(/\/$/, ""),
    database: process.env.ACT_DB!,
    username: process.env.ACT_USER!,
    password: process.env.ACT_PASS!,
  });
}
