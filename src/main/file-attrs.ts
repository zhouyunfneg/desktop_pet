/**
 * 文件属性读写 + 让 explorer 认账（koffi → kernel32 / shell32 / user32）。
 * 只为一件事：整理时把桌面上那一个图标临时藏起来（改它的隐藏属性），放下时再改回去。
 * 桌面没有「隐藏单个图标」的接口，写坐标也藏不住（越界会被夹回屏幕里的格点），
 * 所以只能走属性这一条路 —— 也因此必须记住原来的属性，不能顺手把只读一类的位改掉。
 */
import * as koffi from "koffi";
import { attrsAfter, INVALID_FILE_ATTRIBUTES, isHiddenAttr } from "../shared/file-attrs";

const kernel32 = koffi.load("kernel32.dll");
const user32 = koffi.load("user32.dll");
const shell32 = koffi.load("shell32.dll");
const GetFileAttributesW = kernel32.func("uint32 __stdcall GetFileAttributesW(str16)");
const SetFileAttributesW = kernel32.func("bool __stdcall SetFileAttributesW(str16, uint32)");
const SHChangeNotify = shell32.func("void __stdcall SHChangeNotify(int32, uint32, str16, void*)");
const FindWindowW = user32.func("void* __stdcall FindWindowW(str16, str16)");
const FindWindowExW = user32.func("void* __stdcall FindWindowExW(void*, void*, str16, str16)");
const PostMessageW = user32.func("bool __stdcall PostMessageW(void*, uint32, uint64, int64)");

const SHCNE_UPDATEDIR = 0x1000;
/** dwItem1 是宽字符路径；FLUSH = 等所有外壳接收方处理完再返回 */
const SHCNF_PATHW_FLUSH = 0x0005 | 0x1000;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const VK_F5 = 0x74;

/**
 * 只让 explorer 重读这一个目录：桌面上那一个图标消失 / 回来，其余一个都不动。
 * 实测（10ms 采样桌面图标总数）：总数只在 24↔23 之间变一次，没有任何整屏重画。
 */
export function refreshFolder(dir: string): boolean {
  if (!dir) return false;
  try {
    SHChangeNotify(SHCNE_UPDATEDIR, SHCNF_PATHW_FLUSH, dir, null as never);
    return true;
  } catch (err) {
    console.warn("[attrs] SHChangeNotify(UPDATEDIR) 失败", dir, err);
    return false;
  }
}

/**
 * 兜底：给桌面按一次 F5。
 * 这是整份重读 —— 图标总数会瞬间掉到 0 再涨回来，肉眼看到的就是「屏幕一闪」，
 * 所以只有 refreshFolder 没让图标消失时才用它。
 */
export function refreshDesktop(): boolean {
  try {
    const progman = FindWindowW("Progman", null);
    const defView = FindWindowExW(progman as never, null, "SHELLDLL_DefView", null);
    if (!defView) return false;
    PostMessageW(defView as never, WM_KEYDOWN, VK_F5, 0);
    PostMessageW(defView as never, WM_KEYUP, VK_F5, 0);
    return true;
  } catch (err) {
    console.warn("[attrs] 刷新桌面失败", err);
    return false;
  }
}

/** \\?\ 前缀可以绕过 260 字符限制，也能保住名字里结尾的空格和点 */
function candidates(p: string): string[] {
  if (!p || p.startsWith("\\\\?\\")) return [p];
  const longPath = "\\\\?\\" + p;
  return p.length > 240 ? [longPath, p] : [p, longPath];
}

/** 文件所在目录（\\?\ 前缀要留着，不然长路径又会栽在 260 字符上） */
function dirOf(p: string): string {
  const cut = p.lastIndexOf("\\");
  return cut > 0 ? p.slice(0, cut) : "";
}

/** 读属性；读不到（文件不存在、没权限）返回 null */
export function readAttrs(p: string): number | null {
  for (const c of candidates(p)) {
    try {
      const a = Number(GetFileAttributesW(c) as never) >>> 0;
      if (a !== INVALID_FILE_ATTRIBUTES) return a;
    } catch (err) {
      console.warn("[attrs] GetFileAttributesW 失败", p, err);
      return null;
    }
  }
  return null;
}

/**
 * 藏 / 现一个文件，并只重读它所在的那个目录。
 * 返回 wasHidden = 动手之前它是不是已经隐藏的，调用方必须记住这个值：
 * 本来就隐藏的文件，归还时不能替它显形。
 */
export function setHidden(p: string, hidden: boolean): { ok: boolean; wasHidden: boolean } {
  const prev = readAttrs(p);
  if (prev === null) return { ok: false, wasHidden: false };
  const wasHidden = isHiddenAttr(prev);
  if (wasHidden === hidden) return { ok: true, wasHidden };
  const next = attrsAfter(prev, hidden);
  for (const c of candidates(p)) {
    try {
      if (SetFileAttributesW(c, next) as never) {
        refreshFolder(dirOf(c));
        return { ok: true, wasHidden };
      }
    } catch (err) {
      console.warn("[attrs] SetFileAttributesW 失败", p, err);
      return { ok: false, wasHidden };
    }
  }
  return { ok: false, wasHidden };
}
