import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*" -> "./src/*" path mapping — needed by
    // tests that exercise a source file (e.g. src/lib/pdf.ts) which itself
    // imports other app modules via "@/..." rather than relative paths.
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Almost all of the run is module loading, not assertions: a full run
    // spends ~15s of cumulative import time against ~1.3s actually executing
    // tests. Isolation is what forces that cost, because each test file
    // otherwise gets a fresh module registry and re-imports the same app
    // modules from scratch. Sharing one registry per worker took the suite
    // from ~11.4s to ~5.1s with all 1249 tests still passing.
    //
    // This is only safe because the suite has no per-file module state to
    // protect: it uses no vi.mock, no vi.fn, no fake timers, no network and
    // no database — every test imports pure functions and asserts on their
    // return values. Introducing any of those makes shared state observable
    // between files, and this flag has to be reconsidered before the first
    // such test lands rather than after it starts flaking.
    isolate: false,
    // Threads share a process, so the one-registry-per-worker win above is
    // spread over fewer registries than forks would give, and worker startup
    // is cheaper. Nothing here calls process.chdir or leaks native handles,
    // which are the usual reasons to prefer forked child processes.
    pool: 'threads',
    // Vitest's own `typecheck` stays off (its default): test types are checked
    // by `npx tsc -p tests --noEmit` via tests/tsconfig.json, which is also
    // what editors pick up, so type errors surface without slowing the run.
  },
});
