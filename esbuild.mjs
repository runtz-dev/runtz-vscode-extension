import * as esbuild from "esbuild"

const watch = process.argv.includes("--watch")
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  logLevel: "info",
  minify: false,
  outfile: "dist/extension.js",
  platform: "node",
  sourcemap: watch,
  target: "node20",
}

if (watch) {
  const context = await esbuild.context(options)
  await context.watch()
  console.log("Watching Runtz extension sources...")
} else {
  await esbuild.build(options)
}
