import type { AppConfig, CategoryRule, Rect, Zone } from "./config";
import type { IconMove, SkippedFile, ZoneSummary } from "./organize";
import type { MenuAction, MenuRequest } from "./menu";
import type { WeatherReply } from "./weather";
import type { NewsReply } from "./news";

export type { AppConfig, CategoryRule, Rect, Zone };
export type { MenuAction, MenuEntry, MenuGroup, MenuRequest } from "./menu";
export type { WeatherMood, WeatherReply } from "./weather";
export type { NewsPick, NewsReply, NewsRound } from "./news";

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
  /** 整理桌面：按分类把图标挪进区域矩形（文件原地不动，可撤销）。已封存，代码留着 */
  organize: "pet:organize",
  /** 只算不搬：预览这次会挪多少、跳过多少 */
  previewOrganize: "pet:preview-organize",
  /** 收纳模式：只读算「哪个散文件进哪个分类文件夹」，给确认面板列清单 */
  foldPreview: "pet:fold-preview",
  /** 主 → 渲染：把收纳清单弹出来让用户点头，确认后才真搬文件 */
  foldAsk: "pet:fold-ask",
  /** 渲染 → 主：用户点了「开始收纳」，这一步会真的移动文件 */
  foldRun: "pet:fold-run",
  /** 渲染 → 主：收纳跑完后把剩下的图标排成竖栏（只挪坐标，不动文件） */
  columnsRun: "pet:columns-run",
  /** 撤销最近一次整理，把图标挪回原位 */
  undoOrganize: "pet:undo-organize",
  /** 撤销一次收纳：图标回原位 + 文件从分类文件夹搬回桌面 */
  undoFold: "pet:undo-fold",
  /** 狗跑到区域放下时，主进程把藏起来的真图标写到落点 */
  settleIcon: "pet:settle-icon",
  /** 狗扒拉到图标了：主进程把真图标临时藏起来，渲染层开始在狗嘴里画假图标 */
  grabIcon: "pet:grab-icon",
  /** 没叼完就中断（拎起狗、撤销）：让藏起来的图标显形并回到原处 */
  carryCancel: "pet:carry-cancel",
  /** 主 → 渲染：整理完成，狗按 steps 逐个跑到图标→区域 */
  organizeDone: "pet:organize-done",
  /** 渲染层请求实时天气（点击狗头） */
  weather: "pet:weather",
  /** 渲染层请求一条实时新闻（点击狗前胸口；原来是每小时自动推，现在改成点一下才播） */
  news: "pet:news",
  /** 主 → 渲染：右键了，把这一份菜单画出来 */
  menuShow: "pet:menu-show",
  /** 渲染 → 主：选了某一项，或者点了外面（null = 取消） */
  menuPick: "pet:menu-pick"
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
  /** 因超过单次上限而根本没尝试的文件数（0 表示没有截断） */
  overflow: number;
}

/** 主进程推给渲染层的开饭通知 */
export interface AteEvent {
  items: FedItem[];
  /** 需要狗顺口交代一句的附加信息，比如「剩下的没吃，一次最多 50 个」 */
  note?: string;
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

/** 确认面板上的一组：某个分类文件夹 + 要收进去的文件 */
export interface FoldGroupView {
  label: string;
  /** 桌面上那个文件夹的名字 */
  folder: string;
  color: string;
  files: string[];
  /** 这个文件夹是这次要新建的 */
  willCreate: boolean;
}

/** 收纳清单（只读算出来的，一个文件都还没动） */
export interface FoldPreviewResult {
  groups: FoldGroupView[];
  /** 不动的那些 + 为什么不动，必须逐条说清 */
  skipped: SkippedFile[];
  total: number;
  canUndo: boolean;
}

/** 一步搬运：狗从图标位置（grab）跑到区域位置（drop）；坐标为 DIP，与区域配置、画布同一单位 */
export interface IconStep {
  index: number;
  /** 图标显示名；settle 时按名字重查当前 index（桌面可能重排，计划时的 index 会失效） */
  name: string;
  /** 分类中文名，狗嘴上的假图标用它标出「这是一份什么」 */
  category: string;
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
  /**
   * fold = 往分类文件夹里放（放到最后一个才真搬文件）；
   * columns = 只把图标排成竖栏；zones = 老的区域模式。
   * 渲染层靠它决定这一批跑完之后要不要接着排整齐。
   */
  phase: "fold" | "columns" | "zones";
}

/** 撤销一次收纳的回报：图标挪回几个、文件搬回几个、哪些没成 */
export interface FoldUndoResult {
  icons: number;
  files: number;
  failed: SkippedFile[];
}

/** 设置页一次拿齐所有输入，任何改动后主进程也回一份，UI 就不存在本地脏状态 */
export interface UiState {
  settings: Settings;
  config: AppConfig;
  /** 工作区（DIP），mini-map 换算区域坐标要用 */
  workArea: Rect;
  /** 真实桌面目录，已跟随重定向 */
  desktopDir: string;
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
  /** 狗的名字：右键菜单头部那一行，用户可以自己起（清洗规则见 shared/normalize.ts） */
  petName: string;
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

  // —— 桌面整理 ——
  organize(): Promise<OrganizeResult>;
  previewOrganize(): Promise<OrganizeResult>;
  /** 只读算收纳清单（一个文件都不动） */
  foldPreview(): Promise<FoldPreviewResult>;
  /** 用户点头之后才开始真搬文件 */
  foldRun(): Promise<OrganizeResult>;
  /** 收纳跑完后把剩下的图标排成竖栏 */
  columnsRun(): Promise<OrganizeResult>;
  undoOrganize(): Promise<UndoResult>;
  /** 撤销：图标放回原位 + 文件从分类文件夹搬回桌面 */
  undoFold(): Promise<FoldUndoResult>;
  /** 主 → 渲染：把收纳清单交给确认面板 */
  onFoldAsk(handler: (preview: FoldPreviewResult) => void): void;
  settleIcon(name: string): void;
  /**
   * 叼起某个图标：主进程把真图标藏到屏幕外，返回 true 才轮到渲染层画嘴上的假图标。
   * 返回 false = 桌面上找不到这个图标或写坐标没成功，此时真图标还看得见，
   * 再画一个假的就会出现「同一个文件两份」。
   */
  grabIcon(name: string): Promise<boolean>;
  /** 没叼完就中断：把藏起来的真图标放回原处 */
  cancelCarry(): void;
  onOrganize(handler: (event: OrganizeEvent) => void): void;

  // —— 天气与新闻 ——
  /** 点击狗头：拿实时天气 + 该演哪个天气动作（查不到时 text 为空串） */
  getWeather(): Promise<WeatherReply>;
  /** 点击狗前胸口：拿一条今天的新闻（每条只播一次，播完自动开下一轮；查不到时 text 为空串） */
  getNews(): Promise<NewsReply>;

  // —— 右键菜单 ——
  /** 主进程下发菜单结构，渲染层画玻璃菜单；null = 收起 */
  onMenu(handler: (request: MenuRequest | null) => void): void;
  /** 选了一项（动作名），或者点了外面（null） */
  pickMenu(action: MenuAction | null): void;
}
