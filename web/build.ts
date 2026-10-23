import { rm } from "node:fs/promises"
import tailwind from "bun-plugin-tailwind"

const outdir = `${import.meta.dir}/dist`
await rm(outdir, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [`${import.meta.dir}/index.html`],
  outdir,
  publicPath: "/", // absolute so SPA deep links (/configure/models) find the bundle
  plugins: [tailwind],
  minify: true,
  target: "browser",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
})
if (!result.success) {
  for (const l of result.logs) console.error(l)
  process.exit(1)
}
console.log(`web: ${result.outputs.length} files -> web/dist`)
