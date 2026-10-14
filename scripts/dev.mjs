import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainEntry = path.join(root, "dist", "electron", "main", "index.js");
const port = Number(process.env.DPET_PORT ?? 5173);
const devUrl = `http://localhost:${port}/`;

const children = [];
let electronChild = null;
let closing = false;

function prefix(name) {
  const tag = `[${name}]`.padEnd(9);
  return (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) process.stdout.write(`${tag} ${line}\n`);
    }
  };
}

function run(name, args, opts = {}) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "pipe", ...opts });
  child.stdout.on("data", prefix(name));
  child.stderr.on("data", prefix(name));
  child.on("exit", (code) => {
    if (closing) return;
    console.error(`[${name}] 退出，code=${code}，整个开发环境终止`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function startElectron() {
  if (electronChild && !electronChild.killed) kill(electronChild);
  electronChild = run("electron", [path.join(root, "node_modules/electron/cli.js"), "."], {
    env: { ...process.env, VITE_DEV_SERVER_URL: devUrl }
  });
}

function kill(child) {
  if (child?.killed || child?.exitCode !== null) return;
  if (process.platform === "win32") {
    // 非 detached 的子进程收不到信号，用 taskkill 连带子树一起收
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitFor(label, probe, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`等待 ${label} 超时`);
  return false;
}

async function devServerUp() {
  try {
    const res = await fetch(devUrl);
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

function shutdown(code = 0) {
  closing = true;
  for (const c of children) kill(c);
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("① tsc 监听主进程/preload  ② vite 起渲染层 dev server  ③ 拉起 Electron");
run("tsc", [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.electron.json", "--watch", "--preserveWatchOutput"]);
run("vite", [path.join(root, "node_modules/vite/bin/vite.js"), "--port", String(port)]);

if (!(await waitFor("主进程编译产物", () => Promise.resolve(existsSync(mainEntry))))) shutdown(1);
if (!(await waitFor("vite dev server", devServerUp))) shutdown(1);

startElectron();

// 主进程/preload 改动没有热更新，靠监听产物 mtime 重启 Electron
let lastBuild = statSync(mainEntry).mtimeMs;
setInterval(() => {
  if (closing || !existsSync(mainEntry)) return;
  const now = statSync(mainEntry).mtimeMs;
  if (now > lastBuild) {
    lastBuild = now;
    console.log("[dev] 主进程有改动，重启 Electron");
    startElectron();
  }
}, 800);
