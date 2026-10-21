/** 临时：把 docs/wx-check/main.ts 打成一个能 file:// 打开的单文件测量页 */
import { build } from "vite";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const OUT = join(ROOT, "dist", "wx-check");
rmSync(OUT, { recursive: true, force: true });

await build({
  configFile: false,
  logLevel: "warn",
  root: join(ROOT, "docs", "wx-check"),
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: "chrome120",
    minify: false,
    lib: {
      entry: resolve(ROOT, "docs/wx-check/main.ts"),
      formats: ["iife"],
      name: "wxcheck",
      fileName: () => "wx.js"
    }
  }
});

const js = readFileSync(join(OUT, "wx.js"), "utf8");
writeFileSync(join(OUT, "index.html"), `<!doctype html><html><body><script>${js}</script></body></html>`);
rmSync(join(OUT, "wx.js"), { force: true });
console.log("测量页:", join(OUT, "index.html"), readdirSync(OUT).join(","));
