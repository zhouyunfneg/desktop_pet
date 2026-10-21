import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateConfig, type AppConfig } from "../shared/config";
import {
  normalizeCarry,
  normalizeFold,
  normalizeSettings,
  normalizeUndo,
  type CarryLog,
  type FoldLog,
  type FoldRecord,
  type HiddenRecord,
  type MoveRecord,
  type MoveSession,
  type UndoLog
} from "../shared/normalize";
import { type Settings } from "../shared/ipc";

/**
 * 极简 JSON 存档。
 * 没用 electron-store：它 v9+ 是 ESM-only、和 CJS 主进程冲突；这里几十行解决且零依赖，
 * 读写都是「剥 BOM + 原子替换 + 去抖合并」。
 *
 * 成长系统已按需求取消。现在四份存档：settings.json（窗口与漫游）、config.json（分类规则与区域）、
 * organize.json（图标坐标的撤销栈）、fold.json（真搬文件的账），外加 carry.json（叼着没放的那一个）。
 * 存档的清洗函数都是纯函数，放在 shared/normalize.ts 里以便单测。
 */
class JsonStore<T extends object> {
  private readonly file: string;
  private data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(fileName: string, normalize: (raw: unknown) => T) {
    this.file = join(app.getPath("userData"), fileName);
    this.data = normalize(this.readRaw());
  }

  private readRaw(): unknown {
    try {
      if (!existsSync(this.file)) return null;
      const text = readFileSync(this.file, "utf8");
      // 记事本/PowerShell 改过存档会带 UTF-8 BOM，不剔掉 JSON.parse 会直接报错，
      // 然后用户会觉得「我改的配置没生效」。
      return JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch (err) {
      console.warn(`[store] ${this.file} 解析失败，回落默认值`, err);
      return null;
    }
  }

  get(): Readonly<T> {
    return this.data;
  }

  set(patch: Partial<T>): void {
    this.data = { ...this.data, ...patch };
    this.scheduleFlush();
  }

  /** 整体替换：清洗后的配置直接覆盖，不做逐字段 patch */
  replace(next: T): void {
    this.data = next;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // 先写临时文件再改名，避免崩溃瞬间留下半截 JSON
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[store] 写入 ${this.file} 失败`, err);
    }
  }
}

export const settingsStore = new JsonStore<Settings>("settings.json", normalizeSettings);
export const configStore = new JsonStore<AppConfig>("config.json", (raw) => validateConfig(raw));
export const organizeStore = new JsonStore<UndoLog>("organize.json", normalizeUndo);
/** 狗嘴里正叼着（临时隐藏）的那一个文件；崩溃后靠它把文件变回来 */
export const carryStore = new JsonStore<CarryLog>("carry.json", normalizeCarry);
/** 真搬进分类文件夹的账：撤销按它把文件搬回来，崩溃后靠它知道哪些已经搬了 */
export const foldStore = new JsonStore<FoldLog>("fold.json", normalizeFold);

export type { FoldRecord, HiddenRecord, MoveRecord, MoveSession, UndoLog };

app.on("before-quit", () => {
  settingsStore.flush();
  configStore.flush();
  organizeStore.flush();
  carryStore.flush();
  foldStore.flush();
});
