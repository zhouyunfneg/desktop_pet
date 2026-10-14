import { defineConfig } from "vite";

// M1 渲染层是纯 Canvas2D + TS，不需要打包框架；Vite 只负责 dev server（HMR）与生产静态构建。
// 文件名用 .mts：Vite 8 之后按 native loader 加载配置，.ts 会被当成 CJS 而报 ESM 语法警告。
export default defineConfig({
  root: "src/renderer",
  base: "./",
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "chrome120"
  }
});
