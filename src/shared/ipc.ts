import type { AppConfig, CategoryRule, Rect, Zone } from "./config";
import type { IconMove, SkippedFile, ZoneSummary } from "./organize";

export type { AppConfig, CategoryRule, Rect, Zone };

/** 体型档位。成长系统已取消，现在只作为 dev 预览钩子（DPET_STAGE）使用 */
export type Stage = "puppy" | "teen" | "adult";

/**
 * 漫游策略。
 * chase = 追鼠标（鼠标换边就掉头追，追到保持距离外待机）；
 * flee  = 躲鼠标；wander = 自己闲逛；stay = 不跟随，跑去右下角蹲着。
 */
export type RoamMode = "chase" | "flee" | "wander" | "stay";

/** 主进程 ↔ 渲染进程的唯一契约来源，两侧都从这里取类型，避免字符串漂移。 */
export const IPC = {
  /** 渲染层上报「狗 + 碗 + 气泡」的外接框，主进程据此设置窗口命中区域 */
  setHotRegion: "pet:set-hot-region",
  /** 主进程轮询到的鼠标位置，推给渲染层驱动追/躲行为 */
  cursor: "pet:cursor",
  /** 渲染层用 canvas 现生成托盘图标后交给主进程（免美术素材） */
  trayIcon: "pet:tray-icon",
  /** 直接投放到碗上的文件 → 主进程判定并吃掉 */
  feed: "pet:feed",
  /** 主 → 渲染：食盆文件夹/菜单投喂成功，狗要跑去吃 */
  ate: "pet:ate",
  /** 主 → 渲染：设置或配置变了，两边刷新 */
  stateChanged: "pet:state-changed",
  /** 主 → 渲染：菜单「回到食盆旁」 */
  recall: "pet:recall",
  /** 设置窗：一次拿齐页面要显示的全部状态 */
  getState: "pet:get-state",
  /** 设置窗：改设置（置顶/漫游模式/食盆位置），立即生效 */
  patchSettings: "pet:patch-settings",
  /** 设置窗：保存分类规则与区域 */
  saveConfig: "pet:save-config",
  /** 设置窗：一键生成三个默认区域 */
  seedZones: "pet:seed-zones",
  /** 设置窗/菜单：开关整块画布可点，返回剩余秒数 */
  setFeedingMode: "pet:set-feeding-mode",
  /** 整理桌面：按分类把图标挪进区域矩形（文件原地不动，可撤销） */
  organize: "pet:organize",
  /** 只算不搬：预览这次会挪多少、跳过多少 */
  previewOrganize: "pet:preview-organize",
  /** 撤销最近一次整理，把图标挪回原位 */
  undoOrganize: "pet:undo-organize",
  /** 狗跑到区域放下时，主进程才真正写这个图标的坐标（让图标跟着狗走） */
  settleIcon: "pet:settle-icon",
  /** 主 → 渲染：整理完成，狗按 steps 逐个跑到图标→区域 */
  organizeDone: "pet:organize-done",
  /** 渲染层请求实时天气（点击狗头） */
  weather: "pet:weather",
  /** 主 → 渲染：每小时推送实时新闻 */
  news: "pet:news"
} as const;

export interface FedItem {
  name: string;
  size: number;
  label: string;
}

export interface RejectedItem {
  name: string;
  reason: string;
}

export interface FeedReply {
  ate: FedItem[];
  rejected: RejectedItem[];
}

/** 主进程推给渲染层的开饭通知 */
export interface AteEvent {
  items: FedItem[];
}

/** 整理结果：moved 是计划/已执行的图标移动，skipped 含各类跳过 */
export interface OrganizeResult {
  moved: IconMove[];
  skipped: SkippedFile[];
  zones: ZoneSummary[];
  canUndo: boolean;
}

/** 撤销结果：restored 是搬回原位的数量，remaining 是 undo 日志里还剩的会话数 */
export interface UndoResult {
  restored: number;
  failed: SkippedFile[];
  remaining: number;
}

/** 一步搬运：狗从图标位置（grab）跑到区域位置（drop）；坐标为屏幕物理像素 */
export interface IconStep {
  index: number;
  /** 图标显示名；settle 时按名字重查当前 index（桌面可能重排，计划时的 index 会失效） */
  name: string;
  grabX: number;
  grabY: number;
  dropX: number;
  dropY: number;
  color: string;
}

/** 主 → 渲染：整理完成后驱动狗的搬运动画 */
export interface OrganizeEvent {
  moved: number;
  zones: ZoneSummary[];
  steps: IconStep[];
}

/** 设置页一次拿齐所有输入，任何改动后主进程也回一份，UI 就不存在本地脏状态 */
export interface UiState {
  settings: Settings;
  config: AppConfig;
  /** 工作区（DIP），mini-map 换算区域坐标要用 */
  workArea: Rect;
  /** 真实桌面目录，已跟随重定向 */
  desktopDir: string;
  feedingSecondsLeft: number;
  /** undo 日志里还有没有可撤销的整理会话 */
  canUndo: boolean;
}

/** 狗窗口的设置。没有「窗口位置」这一项：狗窗铺满工作区，狗自己在里面跑 */
export interface Settings {
  version: 1;
  topmost: boolean;
  roamMode: RoamMode;
  /** 追/躲时保持的水平距离（DIP），太小会让鼠标容易误触到狗 */
  keepDistance: number;
  /** 常驻显示整理区域框（不整理时也画出来，方便对准区域范围） */
  showZones: boolean;
}

/** preload 暴露给渲染层的白名单 API，两侧共用同一个形状 */
export interface PetBridge {
  // —— 狗窗用 ——
  /** 上报当前需要接收鼠标命中的矩形（狗 + 碗 + 气泡），其余区域对系统命中测试不存在 */
  setHotRegion(rects: Rect[]): void;
  sendTrayIcon(dataUrl: string): void;
  /** 只递路径；大小、能不能吃、进不进回收站全由主进程定 */
  feed(paths: string[]): Promise<FeedReply>;
  pathForFile(file: File): string;
  onAte(handler: (event: AteEvent) => void): void;
  onState(handler: (state: UiState) => void): void;
  onCursor(handler: (x: number, y: number) => void): void;
  onRecall(handler: () => void): void;

  // —— 设置窗用，每个写操作都回一份新状态 ——
  getState(): Promise<UiState>;
  patchSettings(patch: Partial<Settings>): Promise<UiState>;
  saveConfig(config: AppConfig): Promise<UiState>;
  seedZones(): Promise<UiState>;
  setFeedingMode(seconds: number): Promise<number>;

  // —— 桌面整理 ——
  organize(): Promise<OrganizeResult>;
  previewOrganize(): Promise<OrganizeResult>;
  undoOrganize(): Promise<UndoResult>;
  settleIcon(name: string): void;
  onOrganize(handler: (event: OrganizeEvent) => void): void;

  // —— 天气与新闻 ——
  /** 点击狗头：获取实时天气简述 */
  getWeather(): Promise<string>;
  /** 主进程每小时推送新闻 */
  onNews(handler: (text: string) => void): void;
}
