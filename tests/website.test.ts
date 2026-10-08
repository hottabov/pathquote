import { describe, it, expect } from "vitest";
import {
  checkWebsite,
  normaliseWebsite,
  websiteHref,
  websiteLabel,
  WEBSITE_MAX_LENGTH,
} from "../src/lib/website";

describe("normaliseWebsite", () => {
  it.each([
    // The ACT! shape: a bare domain stays as it is.
    ["www.erpo.de", "www.erpo.de"],
    ["erpo.de", "erpo.de"],
    // A full URL pasted from the address bar loses its scheme and trailing slash.
    ["https://www.erpo.de/", "www.erpo.de"],
    ["https://www.erpo.de", "www.erpo.de"],
    // http is folded to https, and the scheme is not stored at all.
    ["http://x.de", "x.de"],
    ["HTTP://X.DE", "x.de"],
    ["HTTPS://WWW.ERPO.DE/", "www.erpo.de"],
    // Surrounding whitespace is noise.
    ["  www.erpo.de  ", "www.erpo.de"],
    ["\twww.erpo.de\n", "www.erpo.de"],
    // Only the host is lowercased.
    ["WWW.Erpo.DE", "www.erpo.de"],
    ["Example.com/Shop/Item?Id=7#Top", "example.com/Shop/Item?Id=7#Top"],
    // A path or a query survives.
    ["example.com/en/products", "example.com/en/products"],
    ["https://example.com/en/products", "example.com/en/products"],
    ["example.com/en/products/", "example.com/en/products"],
    ["example.com/en/?page=2", "example.com/en/?page=2"],
    ["example.com?lang=de", "example.com?lang=de"],
    ["example.com/#top", "example.com/#top"],
    ["example.com//", "example.com"],
    // A port is part of an address.
    ["example.com:8443/app", "example.com:8443/app"],
    // Multi-label hosts and hyphens.
    ["shop.my-company.co.uk", "shop.my-company.co.uk"],
    // Internationalised hosts.
    ["müller-holz.de", "müller-holz.de"],
    ["Müller-Holz.DE", "müller-holz.de"],
    ["xn--mller-holz-yfb.de", "xn--mller-holz-yfb.de"],
    ["example.xn--p1ai", "example.xn--p1ai"],
  ])("%j -> %j", (input, expected) => {
    expect(normaliseWebsite(input)).toBe(expected);
  });

  it.each([
    ["not a url"],
    ["Not applicable"],
    ["n/a"],
    ["-"],
    ["none"],
    ["www."],
    ["www"],
    ["localhost"],
    ["192.168.0.1"],
    ["http://"],
    ["https://"],
    ["https:///path"],
    // An email address pasted into the website field.
    ["info@erpo.de"],
    ["https://user:pw@erpo.de"],
    // Not web schemes, or not schemes at all.
    ["javascript:alert(1)"],
    [" javascript:alert(1)"],
    ["javascript://example.com/%0aalert(1)"],
    ["data:text/html,x"],
    ["mailto:info@erpo.de"],
    ["ftp://erpo.de"],
    ["//evil.com"],
    ["https:/erpo.de"],
    ["https//erpo.de"],
    // Whitespace in the middle is not a url, even if a prefix looks like one.
    ["erpo.de and erpo.com"],
    ["www.erpo.de/a b"],
    // Malformed hosts.
    ["-erpo.de"],
    ["erpo-.de"],
    ["erpo..de"],
    ["erpo.d"],
    ["erpo.d3"],
    ["erpo.de:"],
    ["erpo.de:port"],
    ["erpo.de\\path"],
    ["<erpo.de>"],
    ["", ],
    ["   "],
  ])("rejects %j", (input) => {
    expect(normaliseWebsite(input)).toBeNull();
  });

  it("returns null for null, undefined and non-strings", () => {
    expect(normaliseWebsite(null)).toBeNull();
    expect(normaliseWebsite(undefined)).toBeNull();
    expect(normaliseWebsite(42 as unknown as string)).toBeNull();
    expect(normaliseWebsite({} as unknown as string)).toBeNull();
  });

  it("is idempotent", () => {
    for (const input of [
      "https://www.erpo.de/",
      "http://X.de",
      "example.com/en/products/",
      "Example.com/Shop?Id=7",
      "müller-holz.de",
    ]) {
      const once = normaliseWebsite(input);
      expect(once, input).not.toBeNull();
      expect(normaliseWebsite(once), input).toBe(once);
    }
  });

  describe("length", () => {
    const pad = (n: number) => "a".repeat(n);

    it("accepts a result of exactly WEBSITE_MAX_LENGTH", () => {
      // example.com/ is 12 characters.
      const value = `example.com/${pad(WEBSITE_MAX_LENGTH - 12)}`;
      expect(value).toHaveLength(WEBSITE_MAX_LENGTH);
      expect(normaliseWebsite(value)).toBe(value);
    });

    it("rejects a result one over", () => {
      expect(normaliseWebsite(`example.com/${pad(WEBSITE_MAX_LENGTH - 11)}`)).toBeNull();
    });

    it("measures the stored form, not the input: the scheme does not count", () => {
      const bare = `example.com/${pad(WEBSITE_MAX_LENGTH - 12)}`;
      expect(normaliseWebsite(`https://${bare}`)).toBe(bare);
    });

    it("reports too-long apart from invalid", () => {
      expect(checkWebsite(`example.com/${pad(500)}`)).toEqual({ ok: false, reason: "too-long" });
      expect(checkWebsite("not a url")).toEqual({ ok: false, reason: "invalid" });
      expect(checkWebsite("https://www.erpo.de/")).toEqual({ ok: true, value: "www.erpo.de" });
    });

    it("rejects an absurdly long host without hanging", () => {
      const started = Date.now();
      expect(normaliseWebsite(`${pad(100_000)}.com`)).toBeNull();
      expect(normaliseWebsite(`${"a-".repeat(50_000)}!.com`)).toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });
});

describe("websiteHref", () => {
  it.each([
    ["www.erpo.de", "https://www.erpo.de"],
    ["example.com/en/products", "https://example.com/en/products"],
    ["example.com/en/?page=2", "https://example.com/en/?page=2"],
    // A row from before the migration, or a value the import wrote raw.
    ["https://www.erpo.de/", "https://www.erpo.de"],
    ["http://x.de", "https://x.de"],
    ["WWW.ERPO.DE", "https://www.erpo.de"],
  ])("%j -> %j", (input, expected) => {
    expect(websiteHref(input)).toBe(expected);
  });

  it("is never relative: always an https URL with a host", () => {
    for (const input of ["www.erpo.de", "erpo.de/x", "https://erpo.de", "http://erpo.de/"]) {
      const href = websiteHref(input);
      expect(href, input).toMatch(/^https:\/\/[^/]+/);
      // The bug this exists for: resolved against the app's own origin, the
      // link must still point at the site, not at a path on the app.
      expect(new URL(href as string, "https://q.pathfindercut.com").host, input).toContain("erpo.de");
    }
  });

  it("returns null for blank values and for values that are not websites", () => {
    for (const input of [null, undefined, "", "   ", "not a url", "javascript:alert(1)", "//evil.com", "info@erpo.de"]) {
      expect(websiteHref(input), String(input)).toBeNull();
    }
  });

  it("documents the bug: the raw stored value is a relative URL", () => {
    // What `<a href={row.website}>` did, and why it must not come back.
    const raw = new URL("www.erpo.de", "https://q.pathfindercut.com/clients").href;
    expect(raw).toBe("https://q.pathfindercut.com/www.erpo.de");
    expect(new URL(websiteHref("www.erpo.de") as string, "https://q.pathfindercut.com/clients").href).toBe(
      "https://www.erpo.de/",
    );
  });
});

describe("websiteLabel", () => {
  it("is the stored value as-is for the stored form", () => {
    expect(websiteLabel("www.erpo.de")).toBe("www.erpo.de");
    expect(websiteLabel("example.com/en/products")).toBe("example.com/en/products");
  });

  it("drops a scheme and trailing slash left by an old row", () => {
    expect(websiteLabel("https://www.erpo.de/")).toBe("www.erpo.de");
    expect(websiteLabel("http://x.de")).toBe("x.de");
  });

  it("shows a value that is not a website, trimmed, rather than hiding it", () => {
    expect(websiteLabel("  not a url ")).toBe("not a url");
    expect(websiteHref("  not a url ")).toBeNull();
  });

  it("returns null for nothing to show", () => {
    expect(websiteLabel(null)).toBeNull();
    expect(websiteLabel(undefined)).toBeNull();
    expect(websiteLabel("")).toBeNull();
    expect(websiteLabel("   ")).toBeNull();
  });
});

/**
 * The shapes the ACT! import actually put in `Company.website`, read off
 * production on 2026-10-08. Twenty years of a free-text field: 1,440 rows with
 * https, 1,474 with http, 4,571 bare, and among the bare ones these.
 *
 * Each is a usable site spoiled by one stray character, so rejecting them would
 * lose a working link over a typo — and a company's website is one of the few
 * things a salesperson opens straight from the client list.
 */
describe("normaliseWebsite against the real imported values", () => {
  it("recovers a site behind leading punctuation", () => {
    expect(normaliseWebsite("/3dbelt.com/our-brands")).toBe("3dbelt.com/our-brands");
    expect(normaliseWebsite("/tyndaleusa.com/about-us/locations")).toBe(
      "tyndaleusa.com/about-us/locations",
    );
    expect(normaliseWebsite(".mareclean.com")).toBe("mareclean.com");
    expect(normaliseWebsite("@sweetvictorian.com")).toBe("sweetvictorian.com");
  });

  it("unwraps a markdown link, including one behind a stray slash", () => {
    // Somebody pasted a formatted link into Act! years ago, and it is in there.
    expect(
      normaliseWebsite("/[www.texasspacovers.com/about-us/](https://www.texasspacovers.com/about-us/)"),
    ).toBe("www.texasspacovers.com/about-us");
    expect(normaliseWebsite("[Acme](https://acme.de)")).toBe("acme.de");
  });

  it("still refuses an email address, which a leading-@ strip must not turn into a host", () => {
    expect(normaliseWebsite("info@erpo.de")).toBeNull();
    expect(normaliseWebsite("sales@3m.co.uk")).toBeNull();
  });

  it("still refuses what is not a website at all", () => {
    expect(normaliseWebsite("???")).toBeNull();
    expect(normaliseWebsite("n/a")).toBeNull();
    expect(normaliseWebsite("not a url")).toBeNull();
  });

  it("lowercases the shouting the data is full of", () => {
    expect(normaliseWebsite("ALDERANDOAKDESIGNS.COM")).toBe("alderandoakdesigns.com");
    expect(normaliseWebsite("A1Spacovers.com")).toBe("a1spacovers.com");
  });
});
