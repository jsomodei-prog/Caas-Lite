import { defineConfig } from "tsup";

export default defineConfig({
  // Single entry point. The SDK is intentionally one file.
  entry: ["src/index.ts"],

  // Both module formats. Consumers pick via their tsconfig/package settings;
  // the exports map in package.json routes them to the right artifact.
  format: ["cjs", "esm"],

  // Emit .d.ts so TypeScript consumers get full types without re-parsing
  // the source.
  dts: true,

  // Don't bundle anything from node_modules. We have zero dependencies
  // and use only Node built-ins (http, https, crypto). Bundling those
  // would be a bug.
  external: ["http", "https", "url", "crypto"],

  // Clean dist/ on each build so stale artifacts can't leak through.
  clean: true,

  // No code splitting — one entry, one output file per format.
  splitting: false,

  // Don't minify. The SDK is small, and unminified output is much
  // easier for consumers to debug if it misbehaves in their environment.
  minify: false,

  // Source maps point back to the .ts source for stack traces.
  sourcemap: true,

  // Target Node 18+, matching package.json engines.
  target: "node18",
});
