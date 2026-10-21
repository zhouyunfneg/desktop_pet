/**
 * 右键菜单的数据契约。
 *
 * 以前菜单是 Electron 原生 Menu，样式碰不到；现在改成渲染层自绘，
 * 所以「有哪些项、当前是什么状态」必须有一份与 UI 无关的单一来源：
 * 主进程按它下发给狗窗画玻璃菜单，也按它生成系统托盘的原生菜单（托盘没法自绘）。
 * 两边共用同一份数据，不会出现「托盘和右键显示的勾选状态不一样」。
 */
import type { RoamMode } from "./ipc";

/**
 * 菜单项动作；主进程按这个枚举分发，渲染层只负责报回来。
 *
 * 只放「真的会用到」的项：撤销整理、显示区域框这类低频开关一律不进菜单，
 * 它们在设置窗里各有一个入口（少一项，菜单就少一行要找的时间）。
 */
export type MenuAction =
  | "follow"
  | "recall"
  | "organize"
  | "feed"
  | "topmost"
  | "toggleVisible"
  | "settings"
  | "devtools"
  | "quit";

export interface MenuEntry {
  action: MenuAction;
  label: string;
  /** 前缀小图标：项目不放任何图片素材，这里用 emoji */
  icon: string;
  /** 右侧灰字提示，比如「进回收站」 */
  hint?: string;
  /** 开关项：undefined 表示不是开关 */
  checked?: boolean;
  enabled: boolean;
}

export interface MenuGroup {
  title: string;
  items: MenuEntry[];
}

/** 主进程下发给渲染层的一次菜单快照（含弹出位置） */
export interface MenuRequest {
  /** 狗窗画布坐标（CSS 像素） */
  x: number;
  y: number;
  groups: MenuGroup[];
  /** 头部第一行：狗的名字，用户在设置窗里自己起 */
  name: string;
  /** 头部第二行小字：陪主人第几小时 */
  statusLine: string;
}

/** 生成菜单需要知道的当前状态 */
export interface MenuInput {
  roamMode: RoamMode;
  keepDistance: number;
  topmost: boolean;
  dogVisible: boolean;
  /** 只有开发调试启动（PET_DEV=1）才给「开发者工具」这一项，正常用时看不到 */
  debugMenu: boolean;
  /** 狗的名字（存档已清洗，这里不再兜底） */
  petName: string;
  /** 本次启动到现在跑了多少秒（主进程 process.uptime()） */
  uptimeSeconds: number;
}

/**
 * 头部那行小字：按「本次启动到现在」数满了几小时，刚启动说 1 小时（0 小时看着像坏了）。
 * 原来这行报的是漫游模式和保持距离，那两样在菜单勾选框和设置窗里都看得到，
 * 占一行小字反而没人读，换成陪伴时长。
 */
export function statusLineOf(input: MenuInput): string {
  const seconds = Number.isFinite(input.uptimeSeconds) ? Math.max(0, input.uptimeSeconds) : 0;
  return `陪主人一共 ${Math.max(1, Math.floor(seconds / 3600))} 小时`;
}

/** 生成菜单结构。纯函数、状态进、结构出，方便单测两边共用同一份 */
export function buildMenu(input: MenuInput): MenuGroup[] {
  const following = input.roamMode !== "stay";

  const play: MenuEntry[] = [
    {
      action: "follow",
      label: "跟随鼠标",
      icon: "🐾",
      checked: following,
      enabled: true
    },
    { action: "recall", label: "回到食盆旁", icon: "🍚", enabled: true }
  ];

  const work: MenuEntry[] = [
    { action: "organize", label: "整理桌面", icon: "🗂", hint: "按分类挪图标", enabled: true },
    { action: "feed", label: "喂文件…", icon: "🦴", hint: "进回收站", enabled: true }
  ];

  const windowGroup: MenuEntry[] = [
    { action: "topmost", label: "始终置顶", icon: "📌", checked: input.topmost, enabled: true },
    {
      action: "toggleVisible",
      label: input.dogVisible ? "隐藏小狗" : "显示小狗",
      icon: input.dogVisible ? "🙈" : "👀",
      enabled: true
    },
    { action: "settings", label: "设置…", icon: "⚙️", enabled: true },
    ...(input.debugMenu
      ? [{ action: "devtools" as MenuAction, label: "打断点调试", icon: "🛠", enabled: true }]
      : []),
    { action: "quit", label: "退出", icon: "🚪", enabled: true }
  ];

  return [
    { title: "陪玩", items: play },
    { title: "干活", items: work },
    { title: "窗口", items: windowGroup }
  ];
}

/** 所有出现过的动作，主进程用来校验渲染层回传的合法性 */
export const MENU_ACTIONS: readonly MenuAction[] = [
  "follow",
  "recall",
  "organize",
  "feed",
  "topmost",
  "toggleVisible",
  "settings",
  "devtools",
  "quit"
];

export function isMenuAction(v: unknown): v is MenuAction {
  return typeof v === "string" && (MENU_ACTIONS as readonly string[]).includes(v);
}
