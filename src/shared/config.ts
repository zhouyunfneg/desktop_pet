/**
 * 桌面整理配置：分类规则 + 自定义区域。
 * M3 负责让用户编辑并校验它，M4 负责按它搬文件，所以这里的清洗必须够狠 ——
 * 用户手滑写进存档的东西不能把主进程带进沟里。
 *
 * 注：成长系统已按需求取消，分类表不再带 XP 系数；原本放在 growth.ts 里的
 * 规则定义挖到这里，growth.ts 已删除。
 */

export interface CategoryRule {
  id: string;
  label: string;
  exts: string[];
  /** 分类与区域共用同一个色，M4 画区域框时直接用 */
  color: string;
}

export const DEFAULT_RULES: CategoryRule[] = [
  { id: "doc", label: "文档", exts: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv"], color: "#4C86E0" },
  { id: "img", label: "图片", exts: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "psd"], color: "#3BA776" },
  { id: "vid", label: "视频", exts: ["mp4", "mkv", "avi", "mov", "flv", "wmv", "webm"], color: "#B267C9" },
  { id: "aud", label: "音频", exts: ["mp3", "wav", "flac", "m4a", "aac", "ogg"], color: "#E0A23B" },
  { id: "arc", label: "压缩包", exts: ["zip", "rar", "7z", "tar", "gz", "bz2"], color: "#D2694B" },
  { id: "app", label: "安装包", exts: ["exe", "msi"], color: "#6B7B8C" },
  { id: "lnk", label: "快捷方式", exts: ["lnk", "url"], color: "#8C8FA8" },
  { id: "other", label: "其他", exts: [], color: "#9AA0A6" }
];

/** 「其他」是兜底项，没有它会有文件无处归类 */
export const CATCH_ALL_ID = "other";

export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function ruleOf(name: string, rules: CategoryRule[] = DEFAULT_RULES): CategoryRule {
  const ext = extOf(name);
  const hit = ext ? rules.find((r) => r.exts.includes(ext)) : undefined;
  return hit ?? rules.find((r) => r.id === CATCH_ALL_ID) ?? rules[rules.length - 1];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Zone {
  id: string;
  name: string;
  /** 绑定的分类规则 id */
  ruleId: string;
  /** 屏幕坐标（DIP），M4 画区域框和判定落点都用它 */
  rect: Rect;
  /** 相对桌面的子目录名；空字符串 = 只挪图标位置不搬文件 */
  dir: string;
  color: string;
  enabled: boolean;
}

export interface AppConfig {
  version: 1;
  rules: CategoryRule[];
  zones: Zone[];
}

const MIN_SIDE = 64;

function cloneRules(rules: CategoryRule[]): CategoryRule[] {
  return rules.map((r) => ({ ...r, exts: [...r.exts] }));
}

export function defaultConfig(): AppConfig {
  return { version: 1, rules: cloneRules(DEFAULT_RULES), zones: [] };
}

/** 区域自动布局：从屏幕右边缘开始，每区域 2 列图标宽，从右往左排列 */
export const ZONE_COLS = 2; // 每区域几列图标
export const ZONE_MARGIN = 20; // 右边缘留白
// 区域之间不留空档，紧挨着排列，保证每个区域的起始位置都是网格的整数倍

/** 首次进入 M4 时给三个 starter 区域：从右往左自动排列，位置按网格对齐 */
export function defaultZones(workArea: Rect, rules: CategoryRule[]): Zone[] {
  const pick = (id: string) => rules.find((r) => r.id === id) ?? rules[rules.length - 1];
  // 区域宽度 = 2 列网格（严格等于网格列宽的整数倍，不加额外 padding）
  const w = ZONE_COLS * 76; // 152px
  // 区域高度 = 全屏幕高度
  const h = workArea.h;
  const doc = pick("doc");
  const img = pick("img");
  const other = pick(CATCH_ALL_ID);
  // 从右往左排列
  const rightStart = workArea.x + workArea.w - ZONE_MARGIN;
  return [
    {
      id: "zone-doc",
      name: "文档区",
      ruleId: doc.id,
      rect: { x: rightStart - w, y: workArea.y, w, h },
      dir: "文档",
      color: doc.color,
      enabled: true
    },
    {
      id: "zone-img",
      name: "图片区",
      ruleId: img.id,
      rect: { x: rightStart - w - w, y: workArea.y, w, h },
      dir: "图片",
      color: img.color,
      enabled: true
    },
    {
      id: "zone-other",
      name: "杂项区",
      ruleId: other.id,
      rect: { x: rightStart - w - w - w, y: workArea.y, w, h },
      dir: "杂项",
      color: other.color,
      enabled: false
    }
  ];
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** 扩展名输入框可以写 "jpg, png;.jpeg"，统一切成小写无点数组 */
export function parseExts(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[,、;；\s]+/)) {
    const e = raw.trim().replace(/^\./, "").toLowerCase();
    if (e && /^[a-z0-9#$%&'+\-^_~]{1,10}$/.test(e)) seen.add(e);
  }
  return [...seen];
}

/** 目录名只允许一段，挡掉 "../.." 和绝对路径 */
function sanitizeDir(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const one = raw.replace(/[\\/:*?"<>|]/g, "").replace(/^\.+/, "").trim();
  return one.slice(0, 40);
}

function sanitizeColor(raw: unknown, fallback: string): string {
  return typeof raw === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.trim()) ? raw.trim() : fallback;
}

function sanitizeRect(raw: unknown, workArea: Rect | null): Rect {
  const r = (raw ?? {}) as Partial<Rect>;
  let x = Math.round(num(r.x, workArea ? workArea.x + 40 : 40));
  let y = Math.round(num(r.y, workArea ? workArea.y + 40 : 40));
  let w = Math.max(MIN_SIDE, Math.round(num(r.w, 240)));
  let h = Math.max(MIN_SIDE, Math.round(num(r.h, 200)));
  if (workArea) {
    // 越界的区域留着没意义，直接夹回工作区
    w = Math.min(w, workArea.w);
    h = Math.min(h, workArea.h);
    x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.w - w));
    y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.h - h));
  }
  return { x, y, w, h };
}

/**
 * 清洗任意来源的配置：补兜底分类、去掉跨类重复的扩展名、
 * 保证 id 唯一、区域必须指向存在的分类。
 */
export function validateConfig(raw: unknown, workArea: Rect | null = null): AppConfig {
  const src = (raw ?? {}) as Partial<AppConfig>;
  const rules: CategoryRule[] = [];
  const takenExts = new Set<string>();
  const seenIds = new Set<string>();

  const list = Array.isArray(src.rules) && src.rules.length > 0 ? src.rules : defaultConfig().rules;
  list.forEach((r, i) => {
    const id = typeof r?.id === "string" && r.id.trim() && !seenIds.has(r.id) ? r.id.trim() : `rule-${i}`;
    seenIds.add(id);
    const exts: string[] = [];
    for (const e of Array.isArray(r?.exts) ? r.exts : []) {
      const key = typeof e === "string" ? e.replace(/^\./, "").toLowerCase().trim() : "";
      // 一个扩展名只能属于一个分类，先到先得，否则归类结果不确定
      if (key && /^[a-z0-9#$%&'+\-^_~]{1,10}$/.test(key) && !takenExts.has(key)) {
        takenExts.add(key);
        exts.push(key);
      }
    }
    rules.push({
      id,
      label: typeof r?.label === "string" && r.label.trim() ? r.label.trim().slice(0, 12) : `分类${i + 1}`,
      exts,
      color: sanitizeColor(r?.color, DEFAULT_RULES[i % DEFAULT_RULES.length].color)
    });
  });
  if (!rules.some((r) => r.id === CATCH_ALL_ID)) {
    rules.push({ id: CATCH_ALL_ID, label: "其他", exts: [], color: "#9AA0A6" });
  }

  const zones: Zone[] = [];
  const seenZone = new Set<string>();
  (Array.isArray(src.zones) ? src.zones : []).forEach((z, i) => {
    if (!z || typeof z !== "object") return;
    const id = typeof z.id === "string" && z.id.trim() && !seenZone.has(z.id) ? z.id.trim() : `zone-${i}`;
    seenZone.add(id);
    const rule = rules.find((r) => r.id === z.ruleId) ?? rules[rules.length - 1];
    zones.push({
      id,
      name: typeof z.name === "string" && z.name.trim() ? z.name.trim().slice(0, 20) : rule.label + "区",
      ruleId: rule.id,
      rect: sanitizeRect(z.rect, workArea),
      dir: sanitizeDir(z.dir),
      color: sanitizeColor(z.color, rule.color),
      enabled: z.enabled !== false
    });
  });

  return { version: 1, rules, zones };
}

export function ruleOfId(config: AppConfig, id: string): CategoryRule {
  return config.rules.find((r) => r.id === id) ?? config.rules[config.rules.length - 1];
}

/** M4 用：这个文件该去哪个启用中的区域 */
export function zoneForFile(config: AppConfig, name: string): Zone | undefined {
  const ext = extOf(name);
  const matched =
    config.rules.find((r) => ext !== "" && r.exts.includes(ext)) ??
    config.rules.find((r) => r.id === CATCH_ALL_ID);
  if (!matched) return undefined;
  return config.zones.find((z) => z.enabled && z.ruleId === matched.id);
}

/** 两个矩形是否重叠，区域排布时提示用户用 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
