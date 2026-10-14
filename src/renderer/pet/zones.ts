import type { Rect } from "../../shared/ipc";

/**
 * 整理区域的可视化：把配置里的区域（绝对 DIP）画到铺满工作区的透明画布上。
 * 画布原点 = 工作区原点，所以画布坐标 = 绝对坐标 - workArea 原点。
 */
export interface ZoneOverlay {
  rect: Rect;
  color: string;
  name: string;
  enabled: boolean;
}

function toCanvas(rect: Rect, wa: Rect): Rect {
  return { x: rect.x - wa.x, y: rect.y - wa.y, w: rect.w, h: rect.h };
}

/** 区域中心点的画布坐标：狗搬运时跑向它、包裹落向它 */
export function zoneCenter(rect: Rect, wa: Rect): { x: number; y: number } {
  return { x: rect.x - wa.x + rect.w / 2, y: rect.y - wa.y + rect.h / 2 };
}

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export function drawZoneFrames(ctx: CanvasRenderingContext2D, zones: ZoneOverlay[], wa: Rect): void {
  for (const z of zones) {
    const c = toCanvas(z.rect, wa);
    const line = z.enabled ? z.color : "#9AA0A6";
    ctx.save();
    // 填充很淡，主要让用户看清「这类文件会被扫进这个范围」
    ctx.fillStyle = hexToRgba(line, z.enabled ? 0.08 : 0.04);
    ctx.strokeStyle = hexToRgba(line, 0.6);
    ctx.lineWidth = 1.5;
    ctx.setLineDash(z.enabled ? [] : [6, 5]);
    ctx.beginPath();
    ctx.roundRect(c.x, c.y, c.w, c.h, 12);
    ctx.fill();
    ctx.stroke();

    // 顶部标签条，写区域名 + 收哪类
    ctx.setLineDash([]);
    ctx.font = "600 12px 'Microsoft YaHei', system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const label = z.enabled ? z.name : `${z.name}（未启用）`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = hexToRgba(line, 0.9);
    ctx.beginPath();
    ctx.roundRect(c.x + 8, c.y + 8, tw + 16, 20, 6);
    ctx.fill();
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(label, c.x + 16, c.y + 18.5);
    ctx.restore();
  }
}
