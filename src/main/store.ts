import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validateConfig, type AppConfig } from "../shared/config";
import { type RoamMode, type Settings } from "../shared/ipc";

/**
 * 极简 JSON 存档。
 * 没用 electron-store：它 v9+ 是 ESM-only、和 CJS 主进程冲突；这里几十行解决且零依赖，
 * 读写都是「剥 BOM + 原子替换 + 去抖合并」。
 *
 * 成长系统已按需求取消，所以只剩两份存档：settings.json（窗口与漫游）、
 * config.json（分类规则与区域）。
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

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** 一次整理会话 = 一批图标的原始坐标；撤销就是把它们写回去 */
export interface MoveRecord {
  /** 图标显示名（index 会变，按名字回匹更稳） */
  name: string;
  x: number;
  y: number;
}
export interface MoveSession {
  id: string;
  at: number;
  moves: MoveRecord[];
}
export interface UndoLog {
  version: 1;
  sessions: MoveSession[];
}

function normalizeUndo(raw: unknown): UndoLog {
  const o = (raw ?? {}) as Partial<UndoLog>;
  const sessions = Array.isArray(o.sessions) ? o.sessions : [];
  return {
    version: 1,
    sessions: sessions
      .map((s) => ({
        id: typeof s?.id === "string" ? s.id : `s-${s?.at ?? 0}`,
        at: num(s?.at, 0),
        moves: (Array.isArray(s?.moves) ? s.moves : [])
          .filter((m) => typeof m?.name === "string" && Number.isFinite(m?.x) && Number.isFinite(m?.y))
          .map((m) => ({ name: m.name, x: Math.round(m.x), y: Math.round(m.y) }))
      }))
      // 空会话不占位，免得撤销点了没反应
      .filter((s) => s.moves.length > 0)
  };
}

/** 老版本/手改坏的字段一律回落到默认值，不让存档有能力炸掉启动 */
function normalizeSettings(raw: unknown): Settings {
  const o = (raw ?? {}) as Partial<Settings> & { origin?: unknown; stage?: unknown };
  const roam: RoamMode =
    o.roamMode === "flee" || o.roamMode === "wander" || o.roamMode === "stay" ? o.roamMode : "chase";
  const keep = num(o.keepDistance, 380);
  const keepDistance = Math.min(Math.max(Math.round(keep), 150), 900);
  return {
    version: 1,
    topmost: typeof o.topmost === "boolean" ? o.topmost : true,
    roamMode: roam,
    showZones: typeof o.showZones === "boolean" ? o.showZones : false,
    // 旧存档里的 origin 字段直接丢弃：狗窗现在铺满工作区，窗口位置没意义了
    // 220 是上一版的默认值，没人手动调过；这一版把跟距调远以免鼠标误触，直接迁移过去
    keepDistance: keepDistance === 220 ? 380 : keepDistance
  };
}

export const settingsStore = new JsonStore<Settings>("settings.json", normalizeSettings);
export const configStore = new JsonStore<AppConfig>("config.json", (raw) => validateConfig(raw));
export const organizeStore = new JsonStore<UndoLog>("organize.json", normalizeUndo);

app.on("before-quit", () => {
  settingsStore.flush();
  configStore.flush();
  organizeStore.flush();
});
