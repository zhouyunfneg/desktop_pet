import type { Stage } from "../../shared/ipc";

/**
 * 柴犬的外形全部由参数生成，不依赖任何图片素材。
 * 局部坐标系：脚底中点为原点，x 朝向狗脸（默认向右），y 向上为正（单位约等于 scale=1 时的像素）。
 */
export interface Coat {
  main: string;
  shade: string;
  cream: string;
  dark: string;
  tongue: string;
}

export interface DogParams {
  /** 整体体型，M2 由 xp 插值驱动 */
  scale: number;
  /** 躯干：后端到前端 */
  bodyBack: number;
  bodyFront: number;
  belly: number;
  back: number;
  /** 地面到髋的高度（不是腿的视觉长度） */
  legLen: number;
  legWidth: number;
  /** 头部 */
  headR: number;
  headX: number;
  headY: number;
  muzzle: number;
  /** 耳朵：0 完全垂下，1 完全立起 */
  earLift: number;
  earLen: number;
  /** 尾巴卷曲度：0 直尾，1 完整卷成圈 */
  tailCurl: number;
  tailWidth: number;
  coat: Coat;
}

const ADULT: DogParams = {
  scale: 1,
  bodyBack: -68,
  bodyFront: 58,
  belly: 38,
  back: 94,
  legLen: 50,
  legWidth: 10.5,
  headR: 32,
  headX: 74,
  headY: 120,
  muzzle: 22,
  earLift: 0.95,
  earLen: 27,
  tailCurl: 0.9,
  tailWidth: 13,
  coat: {
    main: "#E9A25C",
    shade: "#CE8647",
    cream: "#FCF4E6",
    dark: "#33241D",
    tongue: "#E4766F"
  }
};

/** 幼犬不是「缩小的成犬」：头大、腿短、耳未完全立、尾未完全卷 */
const PUPPY: DogParams = {
  ...ADULT,
  scale: 0.72,
  bodyBack: -58,
  bodyFront: 50,
  belly: 34,
  back: 84,
  legLen: 40,
  legWidth: 11,
  headR: 34,
  headX: 68,
  headY: 112,
  muzzle: 19,
  earLift: 0.6,
  earLen: 23,
  tailCurl: 0.45,
  tailWidth: 12
};

const TEEN: DogParams = {
  ...ADULT,
  scale: 0.88,
  bodyBack: -64,
  bodyFront: 55,
  belly: 36,
  back: 90,
  legLen: 45,
  legWidth: 10.5,
  headR: 33,
  headX: 72,
  headY: 117,
  muzzle: 21,
  earLift: 0.82,
  earLen: 25,
  tailCurl: 0.7,
  tailWidth: 12.5
};

const PRESETS: Record<Stage, DogParams> = {
  puppy: PUPPY,
  teen: TEEN,
  adult: ADULT
};

export function paramsFor(stage: Stage): DogParams {
  return PRESETS[stage];
}

/** 画布坐标（y 向下）的轴对齐包围盒，供命中区上报与 M4 落点计算共用 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  cx: number;
  cy: number;
}

export function dogBox(
  p: DogParams,
  canvasX: number,
  groundY: number,
  dir: 1 | -1,
  padding = 0
): Rect {
  const back = -p.bodyBack * p.scale + p.tailWidth * p.scale * 0.7;
  const front = (p.headX + p.headR * 1.5 + p.muzzle) * p.scale;
  const height = (p.headY + p.headR + p.earLen) * p.scale;
  const left = canvasX + (dir > 0 ? -back : -front) - padding;
  const right = canvasX + (dir > 0 ? front : back) + padding;
  const top = groundY - height - padding;
  return {
    left,
    top,
    right,
    bottom: groundY + padding,
    width: right - left,
    height: groundY + padding - top,
    cx: (left + right) / 2,
    cy: (top + groundY) / 2
  };
}

/** 头顶锚点（气泡、爱心的出生点） */
export function headAnchor(p: DogParams, canvasX: number, groundY: number, dir: 1 | -1): { x: number; y: number } {
  return {
    x: canvasX + dir * p.headX * p.scale,
    y: groundY - (p.headY + p.headR * 0.9) * p.scale
  };
}

/**
 * 前胸锚点 + 判定半径（点这里 = 让狗播报新闻）。
 * 局部坐标取「躯干最前面往里一点、肚子和背的中间高度」，就是狗的胸口；
 * 它和头顶圆（更高）、屁股（更后）都不重叠，所以三个部位能分开判。
 */
export function chestAnchor(
  p: DogParams,
  canvasX: number,
  groundY: number,
  dir: 1 | -1
): { x: number; y: number; r: number } {
  return {
    x: canvasX + dir * (p.bodyFront - 6) * p.scale,
    y: groundY - ((p.belly + p.back) / 2) * p.scale,
    r: p.headR * 0.9 * p.scale
  };
}

/**
 * 嘴尖锚点（叼东西时用）。
 * 与 shiba.ts 里 mouth() 的绘制位置同源：头中心 (headX, headY)，
 * 嘴在局部坐标 (headR*1.18, -headR*0.44)，而局部 y 向上为正 → 画布 y 要反过来。
 * 叼东西时头是抬着的，所以按 headDip / headLift 为 0 算。
 */
export function mouthAnchor(p: DogParams, canvasX: number, groundY: number, dir: 1 | -1): { x: number; y: number } {
  return {
    x: canvasX + dir * (p.headX + p.headR * 1.18) * p.scale,
    y: groundY - (p.headY - p.headR * 0.44) * p.scale
  };
}

/** 命中区上报的判定输入：狗的位置 + 朝向 */
export interface ShapeStamp {
  x: number;
  y: number;
  dir: 1 | -1;
}

/**
 * 这一帧要不要重新上报命中区。
 *
 * 迟滞是为了不让 SetWindowRgn 每帧都调（窗口边缘会闪白边），但**掉头必须立刻重报**：
 * 狗的身体两侧宽度差很大（成犬朝头那一侧 144px、朝屁股那一侧 77px，差 67px），
 * 区域还留在上一个朝向时，头那一侧就有一截被窗口裁掉 —— 看起来像「掉头时狗头被遮住一块」。
 */
export function shapeNeedsReport(prev: ShapeStamp | null, now: ShapeStamp, walkThreshold = 24): boolean {
  if (!prev) return true;
  if (prev.dir !== now.dir) return true;
  return Math.abs(now.x - prev.x) >= walkThreshold || Math.abs(now.y - prev.y) >= walkThreshold;
}
