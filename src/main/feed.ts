import { shell } from "electron";
import { promises as fs } from "node:fs";
import { basename, resolve } from "node:path";
import { ruleOf } from "../shared/config";
import {
  MAX_BATCH,
  rejectReason,
  splitFeedBatch,
  type PathKind
} from "../shared/feed-guard";
import type { FedItem, FeedReply, RejectedItem } from "../shared/ipc";

/**
 * 进食服务：只有这一层能碰文件系统，渲染层只能递路径过来。
 * 一切以主进程重新 stat 的结果为准，渲染层报的数一律不信。
 *
 * 「该不该拒」的判定是纯函数，放在 shared/feed-guard.ts 里以便单测；
 * 这里只负责 stat、送回收站、把结果拼回去。
 * 成长系统已取消，所以这里只做「能不能吃 → 进回收站 → 报结果」，不再算数值。
 */

function protectedRoots(): string[] {
  const env = process.env;
  return [env.SystemRoot, env.windir, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => resolve(p));
}

/** lstat 的结果映射成护栏需要的种类 */
function kindOf(errCode: string | null, isFile: boolean, isDir: boolean, isSymlink: boolean): PathKind {
  if (errCode) return isSymlink ? "symlink" : "missing";
  if (isSymlink) return "symlink";
  return isDir ? "dir" : isFile ? "file" : "missing";
}

/**
 * 吃掉一批文件：校验 → 投进回收站 → 返回结果。
 * 只用 shell.trashItem，代码里不存在任何硬删除。
 */
export async function feedFiles(paths: string[]): Promise<FeedReply> {
  const ate: FedItem[] = [];
  const rejected: RejectedItem[] = [];
  const roots = protectedRoots();
  // 超出单次上限的部分记进 overflow，由界面明确回报，不能让用户以为整批都喂掉了
  const { accepted, overflow } = splitFeedBatch(paths, MAX_BATCH);

  for (const raw of accepted) {
    const path = typeof raw === "string" ? raw.trim() : "";
    const name = path ? basename(path) : "(空路径)";

    let errCode: string | null = null;
    let isFile = false;
    let isDir = false;
    let isSymlink = false;
    let size = 0;
    try {
      const stat = await fs.lstat(path);
      isFile = stat.isFile();
      isDir = stat.isDirectory();
      isSymlink = stat.isSymbolicLink();
      size = stat.size;
    } catch (err) {
      errCode = (err as NodeJS.ErrnoException)?.code ?? "ERR";
    }

    const reason = rejectReason(path, kindOf(errCode, isFile, isDir, isSymlink), roots);
    if (reason) {
      rejected.push({ name, reason });
      continue;
    }

    try {
      // 进回收站，不是删除：喂错了还能从回收站捞回来
      await shell.trashItem(path);
    } catch (err) {
      rejected.push({ name, reason: `进不去回收站：${errMessage(err)}` });
      continue;
    }

    // 分类名按文件名算，不能用整条路径：路径里带了别的点号会算错扩展名
    ate.push({ name: basename(path), size, label: ruleOf(basename(path)).label });
  }

  return { ate, rejected, overflow };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) {
    // EPERM/EACCES 对用户来说就是「没权限」，公共桌面那些项经常这样
    if (/EPERM|EACCES|permission/i.test(err.message)) return "没权限（可能是公共桌面项）";
    return err.message.slice(0, 60);
  }
  return String(err).slice(0, 60);
}
