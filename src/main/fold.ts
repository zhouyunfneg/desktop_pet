/**
 * 「收进文件夹」的执行层：真在磁盘上动手的那几个函数都收在这里。
 *
 * 三条硬规矩（都是踩过坑之后定下来的）：
 *  ① 只动用户自己的桌面目录。公共桌面（C:\Users\Public\Desktop）通常没写权限，
 *     而且那里的东西是所有账号共用的，不碰。
 *  ② 每一次改名先记账再动手（fold.json），中途进程没了也能知道哪些真搬了、哪些没搬。
 *     启动时只做「把隐藏属性清掉」这类安全补救，绝不自动把文件搬回来。
 *  ③ 撤销只按账本上的路径搬回，且必须确认目标位置空着才搬，绝不覆盖同名文件。
 */
import { app } from "electron";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { validateConfig, type AppConfig } from "../shared/config";
import { planFold, folderNameOf, type DeskItem, type FoldPlan } from "../shared/fold";
import { foldStore, type FoldRecord } from "./store";
import { refreshFolder, readAttrs, setHidden } from "./file-attrs";

const lower = (s: string): string => s.trim().toLowerCase();

/** 用户桌面（可写）+ 公共桌面（只读看待） */
export function desktopDirs(): { user: string; all: string[] } {
  let user = "";
  try {
    user = app.getPath("desktop");
  } catch (err) {
    console.warn("[fold] 拿不到桌面目录", err);
  }
  const pub = process.env.PUBLIC ? join(process.env.PUBLIC, "Desktop") : "";
  const all = user ? (pub && pub !== user ? [user, pub] : [user]) : pub ? [pub] : [];
  return { user, all };
}

/** 一个路径是否还在某个桌面目录里（撤销搬回来时也要靠它兜底） */
function insideDesktop(p: string): boolean {
  const norm = lower(p);
  return desktopDirs().all.some((d) => norm.startsWith(`${lower(d)}\\`) || norm.startsWith(`${lower(d)}/`));
}

export interface Scan {
  items: DeskItem[];
  /** 分类文件夹名（小写）→ 里面已有的文件名；没有这个文件夹就不出现 */
  folderContents: Map<string, string[]>;
  /** 桌面上已有的文件夹名（小写），用来判断「文档」是不是要新建 */
  deskFolders: Set<string>;
  userDir: string;
}

/** 只读：把桌面上有什么、分类文件夹里有什么读出来 */
export async function scan(config: AppConfig): Promise<Scan> {
  const { user, all } = desktopDirs();
  const items: DeskItem[] = [];
  const deskFolders = new Set<string>();
  const folderContents = new Map<string, string[]>();
  const wanted = new Set(config.rules.map((r) => lower(folderNameOf(r))));

  for (const dir of all) {
    let names: { name: string; isDir: boolean }[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      names = entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch (err) {
      console.warn(`[fold] 读 ${dir} 失败`, err);
      continue;
    }
    for (const n of names) {
      items.push({ name: n.name, isDir: n.isDir, where: dir });
      if (n.isDir) deskFolders.add(lower(n.name));
    }
  }
  // 分类文件夹里已经有的文件：撞名就不能往里塞
  if (user) {
    for (const want of wanted) {
      if (!deskFolders.has(want)) continue;
      const hit = items.find((i) => i.isDir && lower(i.name) === want && i.where === user);
      if (!hit) continue;
      try {
        const inner = await fs.readdir(join(user, hit.name));
        folderContents.set(want, inner);
      } catch (err) {
        console.warn(`[fold] 读 ${hit.name} 失败`, err);
        folderContents.set(want, []);
      }
    }
  }
  return { items, folderContents, deskFolders, userDir: user };
}

export interface FoldPreview {
  plan: FoldPlan;
  scan: Scan;
  config: AppConfig;
}

/**
 * 先把要用到的分类文件夹建出来：狗得有个真实存在的图标可以「放进去」，
 * 不然衔到一半才发现没地方放。已存在的原样用过，不记账（撤销时不删）。
 */
export async function makeFolders(userDir: string, names: string[]): Promise<{ made: string[]; failed: { name: string; reason: string }[] }> {
  const made: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const name of names) {
    const p = join(userDir, name);
    if (!insideDesktop(p)) {
      failed.push({ name, reason: "路径不在桌面目录里" });
      continue;
    }
    try {
      if (await existsPath(p)) continue;
      await fs.mkdir(p);
      made.push(name);
    } catch (err) {
      failed.push({ name, reason: why(err) });
    }
  }
  if (made.length > 0) refreshFolder(userDir);
  return { made, failed };
}

/** 只读算计划：这一步绝不写盘、绝不改属性，给确认面板列清单用 */
export async function preview(rawConfig: AppConfig, protectedNames: Set<string>): Promise<FoldPreview> {
  const config = validateConfig(rawConfig);
  const s = await scan(config);
  const plan = planFold(s.items, config.rules, {
    folderContents: s.folderContents,
    protectedNames,
    writableDirs: new Set(s.userDir ? [s.userDir] : [])
  });
  return { plan, scan: s, config };
}

export interface MoveResult {
  ok: boolean;
  /** 成功时的新路径 */
  to: string;
  /** 目标文件夹是这次新建的（撤销时才有资格删掉它） */
  madeFolder: boolean;
  reason?: string;
  /** 复制成功但原文件没删掉：桌面上还有一份，必须告诉用户 */
  leftover?: string;
}

/**
 * 把桌面上一个文件搬进分类文件夹。
 * 先记账（done:false）再 rename：任何一步失手，账上都留得下线索。
 */
export async function moveInto(userDir: string, folderName: string, fileName: string): Promise<MoveResult> {
  const from = join(userDir, fileName);
  const folder = join(userDir, folderName);
  const to = join(folder, fileName);
  if (!insideDesktop(from) || !insideDesktop(to)) {
    return { ok: false, to: "", madeFolder: false, reason: "路径不在桌面目录里，拒绝移动" };
  }
  let madeFolder = false;
  // 先看清这个文件夹本来在不在：只有这次新建的文件夹，撤销时才有资格删掉
  const pre = await existsPath(folder);
  try {
    await fs.mkdir(folder, { recursive: true });
    madeFolder = !pre;
  } catch (err) {
    return { ok: false, to: "", madeFolder: false, reason: `建不了「${folderName}」：${why(err)}` };
  }
  // 撞名再验一遍：预览到动手之间用户可能自己拖了一个同名文件进去
  if (await existsPath(to)) {
    return { ok: false, to: "", madeFolder, reason: `「${folderName}」里已有同名文件` };
  }
  appendRecord({ from, to, folder, madeFolder, done: false });
  let leftover: string | undefined;
  try {
    await fs.rename(from, to);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code !== "EXDEV") {
      dropRecord(from);
      return { ok: false, to: "", madeFolder, reason: `搬不动：${why(err)}` };
    }
    // 跨盘（桌面被重定向到别的盘时理论上会遇到）：复制一份再删原文件
    try {
      await fs.copyFile(from, to);
    } catch (err2) {
      dropRecord(from);
      return { ok: false, to: "", madeFolder, reason: `复制失败：${why(err2)}` };
    }
    try {
      await fs.rm(from);
    } catch (err2) {
      leftover = from;
      console.warn(`[fold] 已复制到 ${to}，但原文件删不掉`, err2);
    }
  }
  markDone(from);
  // 叼的时候它带着隐藏属性，搬进文件夹后要显形，不然打开文件夹也看不见
  const attrs = readAttrs(to);
  if (attrs !== null && (attrs & 0x2) !== 0) setHidden(to, false);
  refreshFolder(folder);
  refreshFolder(userDir);
  return { ok: true, to, madeFolder, leftover };
}

/** 撤销最近一次收纳：按账本把文件搬回桌面，空了的自动文件夹删掉 */
export async function undoLast(): Promise<{ restored: number; failed: FoldRecord[]; remaining: number }> {
  const log = foldStore.get();
  const last = log.sessions[log.sessions.length - 1];
  if (!last) return { restored: 0, failed: [], remaining: 0 };
  const failed: FoldRecord[] = [];
  let restored = 0;
  const touched = new Set<string>();
  // 倒着搬回去：后进去的先出来，撞名概率最低
  for (const rec of [...last.records].reverse()) {
    if (!rec.done) continue;
    if (!insideDesktop(rec.from) || !insideDesktop(rec.to)) {
      failed.push(rec);
      continue;
    }
    if (await existsPath(rec.from)) {
      failed.push(rec);
      continue;
    }
    try {
      await fs.mkdir(dirname(rec.from), { recursive: true });
      await fs.rename(rec.to, rec.from);
      restored += 1;
      if (rec.madeFolder) touched.add(rec.folder);
    } catch (err) {
      console.warn(`[fold] 撤销 ${rec.to} 失败`, err);
      failed.push(rec);
    }
  }
  for (const folder of touched) {
    // 只删这次新建的、且已经空了的文件夹
    try {
      const left = await fs.readdir(folder);
      if (left.length === 0) await fs.rm(folder, { recursive: true });
    } catch (err) {
      console.warn(`[fold] 空文件夹 ${folder} 没删掉`, err);
    }
  }
  // 搬回去的从账上划掉；没搬成的留着，下次撤销还能再试
  const rest = failed.length > 0 ? [...log.sessions.slice(0, -1), { ...last, records: failed }] : log.sessions.slice(0, -1);
  foldStore.replace({ version: 1, sessions: rest.filter((s) => s.records.length > 0).slice(-10) });
  foldStore.flush();
  refreshAll();
  return { restored, failed, remaining: foldStore.get().sessions.length };
}

/**
 * 启动时核对账本：只做安全补救（把带着隐藏属性卡在文件夹里的文件显形），
 * 绝不自动搬文件。返回一句要转告用户的话，没有异常时返回 null。
 */
export async function recover(): Promise<string | null> {
  const log = foldStore.get();
  let fixedHidden = 0;
  let halfDone = 0;
  for (const s of log.sessions) {
    for (const rec of s.records) {
      if (rec.done) continue;
      const atNew = await existsPath(rec.to);
      const atOld = await existsPath(rec.from);
      if (atNew && !atOld) {
        // 搬成了但没来得及记账：补上账，顺手把它显形
        rec.done = true;
        if (readAttrs(rec.to) !== null) setHidden(rec.to, false);
        fixedHidden += 1;
      } else if (atOld) {
        halfDone += 1;
      }
    }
  }
  if (fixedHidden === 0 && halfDone === 0) return null;
  foldStore.replace({ version: 1, sessions: log.sessions });
  foldStore.flush();
  const parts: string[] = [];
  if (fixedHidden > 0) parts.push(`有 ${fixedHidden} 个文件上次搬到一半没记上账，已经补好账并让它显示出来`);
  if (halfDone > 0) parts.push(`还有 ${halfDone} 个文件上次没搬成，原地没动`);
  return parts.join("；");
}

/** 收纳会话开始：把这一批的意图整批记成一个会话 */
export function beginSession(): string {
  return `f-${Date.now().toString(36)}`;
}

/** 一批收纳结束后落盘（appendRecord 里已经在写，这里只补一次 flush） */
export function endSession(): void {
  foldStore.flush();
}

function currentSessionId(): string {
  const log = foldStore.get();
  const last = log.sessions[log.sessions.length - 1];
  // 只复用 5 分钟内的会话，太久的旧账不该和这次混在一起撤销
  if (last && Date.now() - last.at < 5 * 60_000) return last.id;
  return beginSession();
}

function appendRecord(rec: Omit<FoldRecord, "at">): void {
  const log = foldStore.get();
  const id = currentSessionId();
  const sessions = [...log.sessions];
  const idx = sessions.findIndex((s) => s.id === id);
  const entry: FoldRecord = { ...rec, at: Date.now() };
  if (idx >= 0) sessions[idx] = { ...sessions[idx], records: [...sessions[idx].records, entry] };
  else sessions.push({ id, at: Date.now(), records: [entry] });
  foldStore.replace({ version: 1, sessions: sessions.slice(-10) });
  foldStore.flush();
}

function patchRecord(from: string, patch: Partial<FoldRecord>): void {
  const log = foldStore.get();
  const key = lower(from);
  let changed = false;
  const sessions = log.sessions.map((s) => {
    const records = s.records.map((r) => {
      if (lower(r.from) !== key || r.done) return r;
      changed = true;
      return { ...r, ...patch };
    });
    return { ...s, records };
  });
  if (!changed) return;
  foldStore.replace({ version: 1, sessions });
  foldStore.flush();
}

function markDone(from: string): void {
  patchRecord(from, { done: true });
}

function dropRecord(from: string): void {
  const log = foldStore.get();
  const key = lower(from);
  const sessions = log.sessions
    .map((s) => ({ ...s, records: s.records.filter((r) => lower(r.from) !== key || r.done) }))
    .filter((s) => s.records.length > 0);
  foldStore.replace({ version: 1, sessions: sessions.slice(-10) });
  foldStore.flush();
}

/** 文件夹存不存在（新建的空文件夹撤销时才有资格删） */
async function existsPath(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function why(err: unknown): string {
  const e = err as NodeJS.ErrnoException;
  const map: Record<string, string> = {
    EPERM: "没权限（可能被别的程序占着）",
    EACCES: "没权限",
    EBUSY: "文件正被占用",
    ENOENT: "文件已经不在了",
    EXDEV: "跨磁盘",
    EEXIST: "已经有同名文件",
    EROFS: "只读磁盘"
  };
  return map[e?.code ?? ""] ?? String(e?.message ?? err);
}

function refreshAll(): void {
  const { all } = desktopDirs();
  for (const d of all) refreshFolder(d);
}

export function foldCount(): number {
  return foldStore.get().sessions.reduce((a, s) => a + s.records.filter((r) => r.done).length, 0);
}

export function hasFoldUndo(): boolean {
  return foldStore.get().sessions.some((s) => s.records.some((r) => r.done));
}
