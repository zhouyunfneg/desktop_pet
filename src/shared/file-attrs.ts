/**
 * 「把桌面上那一个图标藏起来」要用的纯逻辑：文件属性怎么改、显示名怎么对到真实文件名。
 * 放在 shared 里是因为这两步最容易出错，而 FFI 本身在 node 下测不了。
 */

export const FILE_ATTRIBUTE_READONLY = 0x1;
export const FILE_ATTRIBUTE_HIDDEN = 0x2;
export const FILE_ATTRIBUTE_NORMAL = 0x80;
/** GetFileAttributesW 失败时的返回值（不是「属性为 -1」，就是失败） */
export const INVALID_FILE_ATTRIBUTES = 0xffffffff;

/**
 * 算出「要写回磁盘的属性值」。
 * 两个坑：
 * 1. 只能改 HIDDEN 这一位，其余（只读、系统、存档…）必须原样带回去，否则用户的只读文件被我们改 writable；
 * 2. 全部位都清光时 Windows 要求显式写 FILE_ATTRIBUTE_NORMAL，传 0 会直接失败。
 */
export function attrsAfter(prevAttrs: number, hidden: boolean): number {
  const p = prevAttrs >>> 0;
  const next = (hidden ? p | FILE_ATTRIBUTE_HIDDEN : p & ~FILE_ATTRIBUTE_HIDDEN) >>> 0;
  return next === 0 ? FILE_ATTRIBUTE_NORMAL : next;
}

export function isHiddenAttr(attrs: number): boolean {
  return (attrs >>> 0 & FILE_ATTRIBUTE_HIDDEN) !== 0;
}

/** 这个「文件名的显示名」是什么：去掉最后一个点之后的扩展名（目录、无扩展名的文件原样返回） */
function displayOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * 桌面显示名 → 目录里真正的文件名。
 * 桌面默认隐藏已知类型的扩展名，所以「报告.docx」显示成「报告」；快捷方式「夸克.lnk」显示成「夸克」。
 * 全名相等和去扩展名相等两类都算候选：「新建文件夹」这个显示名，既可能是那个文件夹，
 * 也可能是「新建文件夹.txt」，两类候选要合在一起数。
 *
 * 候选不止一个就返回 null：认错文件等于把别人家的文件藏起来了，宁可不藏。
 */
export function pickDesktopFile(displayName: string, fileNames: string[]): string | null {
  const key = displayName.trim().toLowerCase();
  if (!key) return null;
  // desktop.ini 是文件夹自己的配置，带系统+隐藏属性，永远不会是桌面上看到的那个图标
  const files = fileNames.filter((f) => f.toLowerCase() !== "desktop.ini");
  const cands: string[] = [];
  for (const f of files) {
    const n = f.toLowerCase();
    if (n === key || displayOf(f).toLowerCase() === key) cands.push(f);
  }
  return cands.length === 1 ? cands[0] : null;
}
