/**
 * 屏幕坐标单位换算。
 *
 * 系统里同时存在两套坐标：
 * - explorer 的桌面 ListView 用原生消息读写图标坐标，单位是**物理像素**；
 * - Electron 的 workArea / 画布 / 区域配置单位是 **DIP**（逻辑像素）。
 * 显示缩放 100% 时两者数值相同，125%/150% 时相差 scaleFactor 倍。
 * 整理链路（读图标 → 算落点 → 写坐标 → 狗跑动）必须全程用同一种单位，
 * 所以只在「进出 FFI 的那一步」做一次换算，其余层一律 DIP。
 *
 * 单独抽成无依赖的纯函数，是为了能在 node 下直接单测（含缩放不等于 1 的用例）。
 */

/** 一个显示器的几何信息：DIP 原点、物理原点、缩放倍数 */
export interface DisplayGeometry {
  /** 显示器边界在 DIP 下的原点 x */
  dipX: number;
  /** 显示器边界在 DIP 下的原点 y */
  dipY: number;
  /** 显示器边界在物理像素下的原点 x */
  physX: number;
  /** 显示器边界在物理像素下的原点 y */
  physY: number;
  /** 缩放倍数，1 = 100% */
  scaleFactor: number;
}

/** 兜底：几何信息拿不到时按 100% 缩放的主屏处理，等价于不换算 */
export const IDENTITY_GEOMETRY: DisplayGeometry = {
  dipX: 0,
  dipY: 0,
  physX: 0,
  physY: 0,
  scaleFactor: 1
};

/** 允许传入非法 scaleFactor（0 / 负数 / NaN），一律退化成 1 */
export function safeGeometry(raw: Partial<DisplayGeometry> | null | undefined): DisplayGeometry {
  const sf = raw?.scaleFactor;
  const ok = typeof sf === "number" && Number.isFinite(sf) && sf > 0;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    dipX: num(raw?.dipX),
    dipY: num(raw?.dipY),
    physX: num(raw?.physX),
    physY: num(raw?.physY),
    scaleFactor: ok ? (sf as number) : 1
  };
}

/**
 * 物理像素 → DIP（读图标坐标时用）。
 * scaleFactor 在函数内部再兜一次底：调用方漏了 safeGeometry 也不会算出 Infinity/NaN 坐标。
 */
export function physToDip(
  phys: number,
  originPhys: number,
  originDip: number,
  scaleFactor = 1
): number {
  const sf = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return originDip + (phys - originPhys) / sf;
}

/** DIP → 物理像素（写图标坐标时用，取整避免 FFI 拿到小数） */
export function dipToPhys(
  dip: number,
  originDip: number,
  originPhys: number,
  scaleFactor = 1
): number {
  const sf = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  return Math.round(originPhys + (dip - originDip) * sf);
}

/** 整批图标坐标：物理像素 → DIP */
export function physListToDip<T extends { x: number; y: number }>(list: T[], g: DisplayGeometry): T[] {
  const safe = safeGeometry(g);
  return list.map((item) => ({
    ...item,
    x: physToDip(item.x, safe.physX, safe.dipX, safe.scaleFactor),
    y: physToDip(item.y, safe.physY, safe.dipY, safe.scaleFactor)
  }));
}

/** 整批目标坐标：DIP → 物理像素 */
export function dipListToPhys<T extends { x: number; y: number }>(list: T[], g: DisplayGeometry): T[] {
  const safe = safeGeometry(g);
  return list.map((item) => ({
    ...item,
    x: dipToPhys(item.x, safe.dipX, safe.physX, safe.scaleFactor),
    y: dipToPhys(item.y, safe.dipY, safe.physY, safe.scaleFactor)
  }));
}
