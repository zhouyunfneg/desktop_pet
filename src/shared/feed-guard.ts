/**
 * 投喂安全护栏（纯函数，从 main/feed.ts 挪出来以便单测）。
 * 原则：宁可少喂一个，也不能顺手把系统文件送进回收站。
 * 这里只做「该不该拒」的判定；真正的 stat 与回收站调用留在主进程。
 */

/** 一次最多吃的份数，防止有人把整个文件夹拖进来 */
export const MAX_BATCH = 50;

/** 一律拒绝的文件名：吃了会坏事的系统占位文件 */
export const PROTECTED_BASENAMES: ReadonlySet<string> = new Set([
  "desktop.ini",
  "thumbs.db",
  "ntldr",
  "boot.ini"
]);

/** 文件在系统层面的种类 */
export type PathKind = "empty" | "relative" | "missing" | "symlink" | "dir" | "file";

/** 跳过原因里没有一条是「未知」，全都能被用户看懂 */
export const REASON_TOO_MANY = `一次最多喂 ${MAX_BATCH} 个，剩下的没动`;

/** 从路径里取最后一段，同时兼容反斜杠与正斜杠 */
export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (seg.length > 0) return seg;
  }
  return "";
}

/** 只接受带盘符、UNC 或明确根路径的绝对路径；相对路径可能指向用户没想到的位置 */
export function isAbsolutePath(path: string): boolean {
  if (!path) return false;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true;
  return /^[\\/]{2}/.test(path) || /^[\\/]/.test(path);
}

/**
 * 路径归一化：统一分隔符、折叠 "." 与 ".."、转小写。
 * 不折叠的话「C:\Windows\..\Users\me\x.txt」会被当成系统目录里的东西，
 * 明明是可吃的文件却被误拒；反过来「C:\Users\..\Windows\xa」也会漏判。
 */
function foldPath(path: string): string {
  const unified = path.replace(/[\\/]+/g, "/");
  const isUnc = unified.startsWith("//");
  const body = isUnc ? unified.slice(2) : unified;
  const segs = body.split("/");
  const hasDrive = /^[a-z]:$/i.test(segs[0] ?? "");
  const out: string[] = hasDrive ? [segs.shift() as string] : [];
  for (const seg of segs) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // 盘符是不能被弹掉的根，弹过头就停在盘符本身
      if (out.length > (hasDrive ? 1 : 0)) out.pop();
      continue;
    }
    out.push(seg);
  }
  return `${isUnc ? "//" : ""}${out.join("/")}`.toLowerCase();
}

/** 归一化用于前缀比较 */
function comparable(path: string): string {
  return foldPath(path);
}

/** 路径是否落在某个受保护的系统目录内（含目录本身） */
export function underProtectedRoot(path: string, protectedRoots: string[]): boolean {
  const target = comparable(path);
  if (!target) return false;
  return protectedRoots.some((root) => {
    const r = comparable(root);
    if (!r) return false;
    return target === r || target.startsWith(r + "/");
  });
}

/**
 * 判断一个投喂请求该不该拒绝。
 * 返回 null = 可以继续送回收站；返回字符串 = 直接报给用户的理由。
 */
export function rejectReason(
  rawPath: string,
  kind: PathKind,
  protectedRoots: string[]
): string | null {
  const path = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!path || kind === "empty") return "路径不合法";
  if (kind === "relative" || !isAbsolutePath(path)) return "路径不合法";
  if (kind === "missing") return "文件不存在或已移动";
  if (kind === "symlink") return "不啃符号链接";
  if (kind === "dir") return "文件夹先不啃";
  if (PROTECTED_BASENAMES.has(basenameOf(path).toLowerCase())) return "系统占位文件，吃了会坏事";
  if (underProtectedRoot(path, protectedRoots)) return "系统目录里的东西不碰";
  return null;
}

/**
 * 批量上限切分。超出部分必须明确告知，否则用户以为整批都喂掉了。
 */
export function splitFeedBatch(
  paths: string[],
  max = MAX_BATCH
): { accepted: string[]; overflow: number } {
  const list = Array.isArray(paths) ? paths : [];
  const limit = Math.max(0, Math.trunc(max));
  return { accepted: list.slice(0, limit), overflow: Math.max(0, list.length - limit) };
}
