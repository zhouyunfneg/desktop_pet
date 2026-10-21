/**
 * 桌面图标 FFI（koffi，预编译二进制、免编译器）。
 * 跨进程读写 explorer.exe 里桌面 SysListView32 的图标坐标，实现「按分类把图标挪进区域」。
 * 所有调用都包了 try/catch 并返回 null/false —— 拿不到窗口或系统结构不同（如 Win11 24H2）时
 * 上层优雅降级，不崩应用。
 */
// koffi 无类型声明，用 shorthand 环境模块声明按 any 用（见 src/main/koffi.d.ts）；
// 本机已验证 win-x64 预编译二进制随包可用
import * as koffi from "koffi";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");

const FindWindowW = user32.func("void* __stdcall FindWindowW(str16, str16)");
const FindWindowExW = user32.func("void* __stdcall FindWindowExW(void*, void*, str16, str16)");
const SendMessageW = user32.func("int64 __stdcall SendMessageW(void*, uint32, int64, int64)");
const SendMessageTimeout = user32.func(
  "int64 __stdcall SendMessageTimeoutW(void*, uint32, int64, int64, uint32, uint32, uint64*)"
);
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void*, uint32*)");
const GetForegroundWindow = user32.func("void* __stdcall GetForegroundWindow()");
const GetClassNameW = user32.func("int32 __stdcall GetClassNameW(void*, void*, int32)");
const SetParent = user32.func("void* __stdcall SetParent(void*, void*)");
const SetWindowPos = user32.func("bool __stdcall SetWindowPos(void*, void*, int32, int32, int32, int32, uint32)");
const EnumWindowsProto = koffi.proto("bool __stdcall EnumWindowsProc(void*, void*)");
const EnumWindows = user32.func("bool __stdcall EnumWindows(EnumWindowsProc *, void*)");

const OpenProcess = kernel32.func("void* __stdcall OpenProcess(uint32, bool, uint32)");
const VirtualAllocEx = kernel32.func("void* __stdcall VirtualAllocEx(void*, void*, size_t, uint32, uint32)");
const VirtualFreeEx = kernel32.func("bool __stdcall VirtualFreeEx(void*, void*, size_t, uint32)");
const WriteProcessMemory = kernel32.func("bool __stdcall WriteProcessMemory(void*, uint64, void*, size_t, size_t*)");
const ReadProcessMemory = kernel32.func("bool __stdcall ReadProcessMemory(void*, uint64, void*, size_t, size_t*)");
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void*)");

const LVM_FIRST = 0x1000;
const LVM_GETITEMCOUNT = LVM_FIRST + 4;
const LVM_GETITEMPOSITION = LVM_FIRST + 16;
const LVM_SETITEMPOSITION32 = LVM_FIRST + 49; // lParam = POINT*
const LVM_GETITEMTEXTW = LVM_FIRST + 115;
const LVM_GETEXTENDEDLISTVIEWSTYLE = LVM_FIRST + 55;
const LVM_SETEXTENDEDLISTVIEWSTYLE = LVM_FIRST + 54;
const LVS_EX_AUTOAUTOARRANGE = 0x100;
const LVIF_TEXT = 0x1;
const MEM_COMMIT = 0x1000;
const MEM_RELEASE = 0x8000;
const PAGE_READWRITE = 0x4;
const PROCESS_VM = 0x38; // OPERATION | READ | WRITE
const TEXT_CAP = 512;
const ITEM_SIZE = 72; // 64 位 LVITEMW 用到的字节数
const REMOTE_SIZE = ITEM_SIZE + TEXT_CAP * 2 + 8;

export interface IconInfo {
  index: number;
  /** 显示名（Windows 隐藏了扩展名，可能不含 .xxx） */
  name: string;
  /** 桌面 ListView 客户区坐标，等同屏幕物理像素（桌面铺满屏幕） */
  x: number;
  y: number;
}

const addr = (p: unknown): bigint => {
  const a = koffi.address(p as never);
  return typeof a === "bigint" ? a : BigInt((a as number) || 0);
};
const buf = (n: number): Buffer => Buffer.alloc(n);

function findListView(): unknown | null {
  const progman = FindWindowW("Progman", null);
  const dv = FindWindowExW(progman as never, null, "SHELLDLL_DefView", null);
  if (dv && addr(dv) !== 0n) {
    const lv = FindWindowExW(dv as never, null, "SysListView32", null);
    if (lv && addr(lv) !== 0n) return lv;
  }
  // 少数主题下 DefView 挂在某个 WorkerW 上
  let worker: unknown = null;
  for (let guard = 0; guard < 64; guard++) {
    worker = FindWindowExW(null, worker as never, "WorkerW", null);
    if (!worker || addr(worker) === 0n) break;
    const d = FindWindowExW(worker as never, null, "SHELLDLL_DefView", null);
    if (d && addr(d) !== 0n) {
      const lv = FindWindowExW(d as never, null, "SysListView32", null);
      if (lv && addr(lv) !== 0n) return lv;
    }
  }
  return null;
}

/** 打开桌面 ListView 所在进程并分配一块远端缓冲；用完必须 releaseRemote 释放 */
interface Session {
  lv: unknown;
  hProc: unknown;
  remote: unknown;
  itemAddr: bigint;
  textAddr: bigint;
  pointAddr: bigint;
  written: unknown;
}

function openSession(): Session | null {
  try {
    const lv = findListView();
    if (!lv) return null;
    const pidBuf = koffi.alloc("uint32", 1);
    GetWindowThreadProcessId(lv as never, pidBuf as never);
    const pid = koffi.decode(pidBuf, "uint32") as number;
    const hProc = OpenProcess(PROCESS_VM, false, pid);
    if (!hProc || addr(hProc) === 0n) return null;
    const remote = VirtualAllocEx(hProc as never, null, REMOTE_SIZE, MEM_COMMIT, PAGE_READWRITE);
    if (!remote || addr(remote) === 0n) {
      CloseHandle(hProc as never);
      return null;
    }
    const base = addr(remote);
    return {
      lv,
      hProc,
      remote,
      itemAddr: base,
      textAddr: base + BigInt(ITEM_SIZE),
      pointAddr: base + BigInt(ITEM_SIZE + TEXT_CAP * 2),
      written: koffi.alloc("size_t", 1)
    };
  } catch (err) {
    console.warn("[icons] openSession 失败", err);
    return null;
  }
}

function closeSession(s: Session): void {
  try {
    VirtualFreeEx(s.hProc as never, s.remote as never, 0, MEM_RELEASE);
    CloseHandle(s.hProc as never);
  } catch (err) {
    console.warn("[icons] closeSession 失败", err);
  }
}

/**
 * 读一个图标的显示名。
 * 任何一步失败都必须报「读不到」而不是返回上一轮的内容：远端缓冲是复用的，
 * 写 LVITEM 失败时 LVM_GETITEMTEXTW 会把上一次那个名字再填一遍，
 * 于是两个图标同名，按名字回匹坐标就会张冠李戴。
 */
function readItemText(s: Session, index: number): string {
  const it = buf(ITEM_SIZE);
  it.writeUInt32LE(LVIF_TEXT, 0);
  it.writeInt32LE(index, 4);
  it.writeInt32LE(0, 8);
  it.writeBigUInt64LE(s.textAddr, 24);
  it.writeInt32LE(TEXT_CAP, 32);
  if (!WriteProcessMemory(s.hProc as never, Number(s.itemAddr), it, ITEM_SIZE, s.written as never)) {
    console.warn(`[icons] 写 LVITEM 失败（index=${index}），跳过该图标`);
    return "";
  }
  const got = Number(SendMessageW(s.lv as never, LVM_GETITEMTEXTW, index, Number(s.itemAddr)));
  if (got <= 0) return "";
  const t = buf(TEXT_CAP * 2);
  if (!ReadProcessMemory(s.hProc as never, Number(s.textAddr), t, TEXT_CAP * 2, s.written as never)) return "";
  const u = t.toString("utf16le");
  const nul = u.indexOf("\0");
  return (nul >= 0 ? u.slice(0, nul) : u).trim();
}

/** 读一个图标的坐标；拿不到返回 null（调用方跳过它，不能拿 (0,0) 当真实位置） */
function readItemPos(s: Session, index: number): { x: number; y: number } | null {
  if (!SendMessageW(s.lv as never, LVM_GETITEMPOSITION, index, Number(s.pointAddr))) return null;
  const p = buf(8);
  if (!ReadProcessMemory(s.hProc as never, Number(s.pointAddr), p, 8, s.written as never)) return null;
  return { x: p.readInt32LE(0), y: p.readInt32LE(4) };
}

/** 写一个图标的坐标；返回是否真的写进去了 */
function writeItemPos(s: Session, index: number, x: number, y: number): boolean {
  const p = buf(8);
  p.writeInt32LE(Math.round(x), 0);
  p.writeInt32LE(Math.round(y), 4);
  if (!WriteProcessMemory(s.hProc as never, Number(s.pointAddr), p, 8, s.written as never)) return false;
  // LVM_SETITEMPOSITION32 返回非 0 才算成功；返回 0 时 explorer 根本没挪这个图标
  return Number(SendMessageW(s.lv as never, LVM_SETITEMPOSITION32, index, Number(s.pointAddr))) !== 0;
}

/** 读出桌面上所有图标的显示名与坐标；失败返回 null */
export function readIcons(): IconInfo[] | null {
  const s = openSession();
  if (!s) return null;
  try {
    const count = Number(SendMessageW(s.lv as never, LVM_GETITEMCOUNT, 0, 0));
    const out: IconInfo[] = [];
    for (let i = 0; i < count; i++) {
      const name = readItemText(s, i);
      if (!name) continue;
      const pos = readItemPos(s, i);
      if (!pos) continue;
      out.push({ index: i, name, x: pos.x, y: pos.y });
    }
    return out;
  } catch (err) {
    console.warn("[icons] readIcons 失败", err);
    return null;
  } finally {
    closeSession(s);
  }
}

/** 批量写图标坐标；只要有一个没写成就返回 false，让上层知道这批没落位 */
export function applyPositions(updates: { index: number; x: number; y: number }[]): boolean {
  if (updates.length === 0) return true;
  const s = openSession();
  if (!s) return false;
  try {
    let failed = 0;
    for (const u of updates) {
      if (!writeItemPos(s, u.index, u.x, u.y)) {
        failed += 1;
        console.warn(`[icons] 坐标写入失败：index=${u.index} @ ${u.x},${u.y}`);
      }
    }
    return failed === 0;
  } catch (err) {
    console.warn("[icons] applyPositions 失败", err);
    return false;
  } finally {
    closeSession(s);
  }
}

/** 关掉「自动排列」扩展样式，否则手动坐标会被系统复位。返回是否检测到并清除 */
export function ensureManualArrange(): boolean {
  const s = openSession();
  if (!s) return false;
  try {
    const style = Number(SendMessageW(s.lv as never, LVM_GETEXTENDEDLISTVIEWSTYLE, 0, 0));
    if (style & LVS_EX_AUTOAUTOARRANGE) {
      SendMessageW(s.lv as never, LVM_SETEXTENDEDLISTVIEWSTYLE, LVS_EX_AUTOAUTOARRANGE, 0);
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[icons] ensureManualArrange 失败", err);
    return false;
  } finally {
    closeSession(s);
  }
}

/**
 * 把一扇窗（HWND）贴到桌面最底层（壁纸之上、图标之下）——WallpaperEngine 同款 WorkerW 技巧。
 * 先给 Progman 发 0x052C 催生一个承载壁纸的 WorkerW，再把窗口 SetParent 到它下面。
 * hwnd 是 BrowserWindow.getNativeWindowHandle() 里读出的 HWND（数值）。
 */
export function attachToDesktopLayer(hwnd: number): boolean {
  try {
    if (!hwnd) return false;
    const progman = FindWindowW("Progman", null);
    if (!progman || addr(progman) === 0n) return false;
    const zero = koffi.alloc("uint64", 1);
    // 0x052C 让 explorer 派生承载壁纸的 WorkerW；无响应也无妨
    try {
      SendMessageTimeout(progman as never, 0x052c, 0, 0, 0x2 /*SMTO_NORMAL*/, 1000, zero as never);
    } catch {
      /* 忽略超时 */
    }

    // 枚举顶层窗口：含 SHELLDLL_DefView 的那个就是 Progman，它之后的下一个 WorkerW 才是壁纸层
    let target = 0n;
    const cb = koffi.register((w: unknown) => {
      const defView = FindWindowExW(w as never, null, "SHELLDLL_DefView", null);
      if (defView && addr(defView) !== 0n) {
        const next = FindWindowExW(null, w as never, "WorkerW", null);
        if (next && addr(next) !== 0n) target = addr(next);
      }
      return true;
    }, koffi.pointer(EnumWindowsProto as never));

    EnumWindows(cb as never, null as never);
    koffi.unregister(cb as never);

    if (target === 0n) return false;
    SetParent(hwnd as never, koffi.as(Number(target), "void*") as never);
    return true;
  } catch (err) {
    console.warn("[icons] attachToDesktopLayer 失败", err);
    return false;
  }
}

/** 从 BrowserWindow.getNativeWindowHandle() 的 Buffer 里读出 HWND 数值 */
export function hwndFromHandle(handle: Buffer): number {
  return handle.readBigInt64LE(0) < 0 ? 0 : Number(handle.readBigInt64LE(0));
}

/**
 * 当前前台是不是桌面本身（Progman / WorkerW）。
 * 用于「区域框只在露出桌面时显示、一切到应用窗口就隐藏」。
 * 无前台窗口（如刚按完 Win+D）也算桌面。
 */
export function isDesktopForeground(): boolean {
  try {
    const fg = GetForegroundWindow();
    if (!fg || addr(fg) === 0n) return true;
    const cn = buf(256 * 2);
    GetClassNameW(fg as never, cn, 256);
    const cls = cn.toString("utf16le").replace(/\0.*$/, "");
    return cls === "Progman" || cls === "WorkerW";
  } catch (err) {
    console.warn("[icons] isDesktopForeground 失败", err);
    return false;
  }
}

/**
 * 兑底方案：把窗口压到普通窗口层的最底（HWND_BOTTOM）。
 * 不像 WorkerW 那样能到图标之下，但会被任何应用窗口盖住、只在露出桌面时可见，
 * 不再常驻最上层。WorkerW 附着失败时用它。
 */
export function sendToBottomLayer(hwnd: number): boolean {
  try {
    if (!hwnd) return false;
    // HWND_BOTTOM=1；SWP_NOSIZE(1)|SWP_NOMOVE(2)|SWP_NOACTIVATE(0x10)
    return Boolean(SetWindowPos(hwnd as never, 1 as never, 0, 0, 0, 0, 0x1 | 0x2 | 0x10));
  } catch (err) {
    console.warn("[icons] sendToBottomLayer 失败", err);
    return false;
  }
}
