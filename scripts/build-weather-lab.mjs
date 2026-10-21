/**
 * 把 docs/weather-lab 打成一个能双击打开的单文件页面（docs/weather-lab.html）。
 *
 * 为什么要打包：浏览器不允许 file:// 下加载 ES 模块（会被同源策略挡掉），
 * 所以必须把 JS 和三份玻璃 CSS 都塞进同一个 HTML 里，才能直接双击看。
 *
 * 用法：node scripts/build-weather-lab.mjs
 * 改完 docs/weather-lab/main.ts 再跑一次就行。
 */
import { build } from "vite";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const LAB = join(ROOT, "docs", "weather-lab");
const OUT = join(ROOT, "dist", "weather-lab");
const GLASS = join(ROOT, "src", "renderer", "glass");

// ① 三份主题 CSS 内联进去（相对路径在 file:// 下同样会挂）
let html = readFileSync(join(LAB, "index.html"), "utf8");
html = html.replace(/<link rel="stylesheet" href="[^"]*\/(solid-glass|tint-presets|theme-shim)\.css" \/>/g, (_m, name) => {
  const css = readFileSync(join(GLASS, `${name}.css`), "utf8");
  return `<style>\n${css}\n</style>`;
});
if (html.includes("<link")) throw new Error("还有没内联掉的 <link>，检查 CSS 路径");
const tmp = join(LAB, "index.build.html");
writeFileSync(tmp, html, "utf8");

// ② vite 打包（只处理那个 <script type="module" src="./main.ts">）
rmSync(OUT, { recursive: true, force: true });
await build({
  root: LAB,
  base: "./",
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: resolve(ROOT, "dist/weather-lab"),
    emptyOutDir: true,
    target: "chrome120",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: { input: { lab: tmp } }
  }
});

// ③ 把产物 JS 内联，并把 module 脚本降级成普通脚本
const built = join(OUT, "index.build.html");
let page = readFileSync(built, "utf8");
// 产物名带 hash（lab-XXXX.js），所以扫目录而不是写死文件名
const assets = join(OUT, "assets");
const jsName = readdirSync(assets).find((f) => /^lab-.*\.js$/.test(f));
if (!jsName) throw new Error(`没找到打包出来的 lab *.js：${readdirSync(assets).join(", ")}`);
const js = readFileSync(join(assets, jsName), "utf8");
// vite 会把 module 脚本提到 <head> 里，内联后会在 #grid 存在之前就执行（mount 直接抛错），
// 所以这里把它从 head 摘掉、改放到 </body> 前面
const scriptTag = new RegExp(`<script type="module"[^>]*src="\\./assets/${jsName}"[^>]*></script>\\s*`);
if (!scriptTag.test(page)) throw new Error("没找到 vite 注入的 module 脚本标签");
page = page.replace(scriptTag, "");
page = page.replace("</body>", `<script>\n${js}\n</script>\n</body>`);
if (page.includes(`assets/${jsName}`)) throw new Error("脚本没被内联，检查 vite 产物名");
// 产物里可能带一个 css link（我们没有额外 css 入口，出现了就说明有意外）
page = page.replace(/<link rel="stylesheet"[^>]*href="\.\/assets\/[^"]*\.css"[^>]*>/g, "");

const finalPath = join(ROOT, "docs", "weather-lab.html");
writeFileSync(finalPath, page, "utf8");

rmSync(tmp, { force: true });
rmSync(OUT, { recursive: true, force: true });
console.log(`已生成 ${finalPath}（${(page.length / 1024).toFixed(0)} KB，双击即可打开）`);
