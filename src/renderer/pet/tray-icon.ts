import { paramsFor } from "./params";

/**
 * 托盘图标也是代码画的：工程里没有任何 .ico/.png，
 * 渲染层启动时生成 dataURL 交给主进程 nativeImage.createFromDataURL。
 */
export function makeTrayIcon(size = 32): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const { main, shade, cream, dark } = paramsFor("adult").coat;
  const s = size / 32;
  ctx.translate(size / 2, size / 2);
  ctx.scale(s, s);
  ctx.translate(0, 0);

  // 双耳
  ctx.fillStyle = main;
  for (const dx of [-11, 11]) {
    ctx.beginPath();
    ctx.moveTo(dx - 5, -6);
    ctx.lineTo(dx, -15);
    ctx.lineTo(dx + 5, -6);
    ctx.closePath();
    ctx.fill();
  }
  // 脸
  ctx.beginPath();
  ctx.ellipse(0, 1, 12, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  // 口鼻奶白区
  ctx.fillStyle = cream;
  ctx.beginPath();
  ctx.ellipse(0, 6, 7.5, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // 眼
  ctx.fillStyle = dark;
  for (const dx of [-5, 5]) {
    ctx.beginPath();
    ctx.ellipse(dx, 0, 1.6, 1.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // 鼻
  ctx.beginPath();
  ctx.ellipse(0, 4.2, 1.9, 1.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // 耳内阴影，小尺寸下也留一点层次
  ctx.fillStyle = shade;
  for (const dx of [-11, 11]) {
    ctx.beginPath();
    ctx.moveTo(dx - 2.5, -7);
    ctx.lineTo(dx, -12);
    ctx.lineTo(dx + 2.5, -7);
    ctx.closePath();
    ctx.fill();
  }

  return canvas.toDataURL("image/png");
}
