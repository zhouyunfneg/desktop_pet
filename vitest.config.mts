import { defineConfig } from "vitest/config";

/**
 * 单独一份 vitest 配置：vite.config.mts 把 root 设成了 src/renderer，
 * 直接复用的话 test/ 目录下的用例会因为相对 root 找不到而被跳过。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false
  }
});
