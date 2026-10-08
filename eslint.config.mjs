import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".worktrees/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // A company's website is stored WITHOUT a scheme ("www.erpo.de"), so putting
  // it straight into an href makes a relative url: the browser resolves it
  // against the current page and the link goes to <this app>/www.erpo.de. That
  // is the bug the ACT! import shipped. Build the href with websiteHref() from
  // src/lib/website.ts. Any identifier or property called "website" inside an
  // href attribute is an error unless it sits inside a websiteHref(...) call, so
  // href={x.website}, href={x.website ?? undefined} and
  // href={`https://${x.website}`} all fail. It cannot see a value copied into
  // another variable first, so keep the call in the href attribute itself.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "JSXAttribute[name.name='href'] :matches(MemberExpression[property.name=/^website$/i], Identifier[name=/^website$/i]):not(CallExpression[callee.name='websiteHref'] *)",
          message:
            "Do not put a stored website in an href: it has no scheme, so the link resolves against this app. Use websiteHref() from @/lib/website.",
        },
      ],
    },
  },
]);

export default eslintConfig;
