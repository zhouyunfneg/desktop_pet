import { join, resolve } from "node:path";

/**
 * 编译产物的目录基准。tsc 把 src/{main,preload,shared} 输出到 dist/electron/ 下并保持层级，
 * 所以 __dirname(dist/electron/main) 往上两层才是 dist —— 之前直接拼 "../renderer" 扑空过一次，
 * 统一收到这里来算。
 */
const distRoot = resolve(__dirname, "../..");

export const PRELOAD_PATH = join(distRoot, "electron", "preload", "index.js");
export const RENDERER_DIR = join(distRoot, "renderer");
export const RENDERER_INDEX = join(RENDERER_DIR, "index.html");
