import { shell } from "electron";
import { promises as fs } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { ruleOf } from "../shared/config";
import type { FedItem, FeedReply, RejectedItem } from "../shared/ipc";

/**
 * 进食服务：只有这一层能碰文件系统，渲染层只能递路径过来。
 * 一切以主进程重新 stat 的结果为准，渲染层报的数一律不信。
 *
 * 成长系统已取消，所以这里只做「能不能吃 → 进回收站 → 报结果」，不再算数值。
 */

/** 一律拒绝的路径特征：宁可少喂一个，也不能顺手把系统文件送进回收站 */
const PROTECTED_BASENAMES = new Set(["desktop.ini", "thumbs.db", "ntldr", "boot.ini"]);
/** 一次最多吃的份数，防止有人把整个文件夹拖进来 */
const MAX_BATCH = 50;

function protectedRoots(): string[] {
  const env = process.env;
  return [env.SystemRoot, env.windir, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => resolve(p).toLowerCase());
}

function isProtected(path: string): boolean {
  const lower = resolve(path).toLowerCase();
  return protectedRoots().some((root) => lower === root || lower.startsWith(root + "\\"));
}

/**
 * 吃掉一批文件：校验 → 投进回收站 → 返回结果。
 * 只用 shell.trashItem，代码里不存在任何硬删除。
 */
export async function feedFiles(paths: string[]): Promise<FeedReply> {
  const ate: FedItem[] = [];
  const rejected: RejectedItem[] = [];

  for (const raw of paths.slice(0, MAX_BATCH)) {
    const path = typeof raw === "string" ? raw.trim() : "";
    const name = path ? basename(path) : "(空路径)";
    if (!path || !isAbsolute(path)) {
      rejected.push({ name, reason: "路径不合法" });
      continue;
    }

    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(path);
    } catch {
      rejected.push({ name, reason: "文件不存在或已移动" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      rejected.push({ name, reason: "不啃符号链接" });
      continue;
    }
    if (!stat.isFile()) {
      rejected.push({ name, reason: "文件夹先不啃" });
      continue;
    }
    if (PROTECTED_BASENAMES.has(basename(path).toLowerCase())) {
      rejected.push({ name, reason: "系统占位文件，吃了会坏事" });
      continue;
    }
    if (isProtected(path)) {
      rejected.push({ name, reason: "系统目录里的东西不碰" });
      continue;
    }

    try {
      // 进回收站，不是删除：喂错了还能从回收站捞回来
      await shell.trashItem(path);
    } catch (err) {
      rejected.push({ name, reason: `进不去回收站：${errMessage(err)}` });
      continue;
    }

    ate.push({ name: basename(path), size: stat.size, label: ruleOf(path).label });
  }

  return { ate, rejected };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    // EPERM/EACCES 对用户来说就是「没权限」，公共桌面那些项经常这样
    if (/EPERM|EACCES|permission/i.test(err.message)) return "没权限（可能是公共桌面项）";
    return err.message.slice(0, 60);
  }
  return String(err).slice(0, 60);
}
