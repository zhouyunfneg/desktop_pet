import type { Rect } from "./params";

/**
 * 食盆：既是「把文件扔进来」的视觉锚点，也是拖放热区。
 * 画在画布坐标里（y 向下），不走狗的翻转坐标系。
 */
export interface Bowl {
  /** 盆底中心 */
  cx: number;
  groundY: number;
  rx: number;
  ry: number;
  height: number;
}

/** 食盆钉在工作区右下角（离右边多远）；狗从左边跑过来低头吃 */
export const BOWL_INSET = 84;

export function makeBowl(roomWidth: number, groundY: number): Bowl {
  const rx = Math.min(40, roomWidth * 0.055);
  return { cx: roomWidth - BOWL_INSET, groundY, rx, ry: rx * 0.26, height: rx * 0.72 };
}

export function bowlBox(bowl: Bowl, padding = 6): Rect {
  const left = bowl.cx - bowl.rx - padding;
  const right = bowl.cx + bowl.rx + padding;
  const top = bowl.groundY - bowl.height - bowl.ry - padding;
  const bottom = bowl.groundY + padding;
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    cx: (left + right) / 2,
    cy: (top + bottom) / 2
  };
}

export interface BowlLook {
  /** 盆里的粮粒数（= 待吃的文件数） */
  kibble: number;
  /** 高亮：正有文件拖到盆上（要吃掉） */
  highlight: boolean;
}

const CLAY = "#C9584A";
const CLAY_DARK = "#9C4136";
const CLAY_LIGHT = "#E0775F";
const KIBBLE = "#8A5A34";

export function drawBowl(ctx: CanvasRenderingContext2D, bowl: Bowl, look: BowlLook): void {
  const { cx, groundY, rx, ry, height } = bowl;
  const topY = groundY - height;

  ctx.save();

  // 影子
  ctx.fillStyle = "rgba(0,0,0,0.14)";
  ctx.beginPath();
  ctx.ellipse(cx, groundY + 2, rx * 0.92, ry * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();

  if (look.highlight) {
    // 可投放时给一圈柔光，告诉用户「扔这儿」
    ctx.fillStyle = "rgba(255,214,102,0.32)";
    ctx.beginPath();
    ctx.ellipse(cx, topY + height * 0.35, rx * 1.5, (ry + height) * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 盆身：上宽下窄的梯形 + 圆底
  ctx.fillStyle = CLAY;
  ctx.beginPath();
  ctx.moveTo(cx - rx, topY);
  ctx.lineTo(cx - rx * 0.62, groundY - ry * 0.6);
  ctx.quadraticCurveTo(cx, groundY + ry * 0.5, cx + rx * 0.62, groundY - ry * 0.6);
  ctx.lineTo(cx + rx, topY);
  ctx.closePath();
  ctx.fill();

  // 盆口内壁
  ctx.fillStyle = CLAY_DARK;
  ctx.beginPath();
  ctx.ellipse(cx, topY, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();

  // 盆沿高光
  ctx.strokeStyle = CLAY_LIGHT;
  ctx.lineWidth = Math.max(2, rx * 0.09);
  ctx.beginPath();
  ctx.ellipse(cx, topY, rx, ry, 0, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();

  // 粮粒：吃几个文件就摆几颗，最多 5 颗，多的挤成一小堆
  const n = Math.max(0, Math.min(look.kibble, 5));
  ctx.fillStyle = KIBBLE;
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const kx = cx + (t - 0.5) * rx * 1.1;
    const ky = topY - ry * 0.25 - (i % 2) * ry * 0.35;
    ctx.beginPath();
    ctx.ellipse(kx, ky, rx * 0.13, rx * 0.1, 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
