import type { DogParams } from "./params";
import type { Pose } from "./pose";

const TAU = Math.PI * 2;

/**
 * 程序化柴犬（纯侧视，脸朝 +x）。
 * 局部坐标：脚底中点为原点、y 向上为正，先 scale(dir, -1) 再画，
 * 于是所有高度都写成正数（p.back = 背离地多高）。
 * 躯干不用胶囊：臀 + 胸两个圆 + 一条带腰凹的连接体，才不会画成河马。
 */
export function drawShiba(ctx: CanvasRenderingContext2D, pose: Pose): void {
  const p = pose.params;
  shadow(ctx, p, pose);

  ctx.save();
  ctx.translate(pose.x, pose.groundY);
  ctx.scale(pose.dir * p.scale, -p.scale);
  // 奔跑前倾：局部空间里 y 向上，所以负角度 = 上半身往脸的方向倒
  if (pose.lean !== 0) ctx.rotate(-pose.lean);
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";

  const top = p.back + pose.breath * 2 + pose.bob;
  const bottom = p.belly - pose.squash * 6;
  // legLen 就是地到髋的高度，所以 angle=0 时脚掌刚好落地
  const hipY = p.legLen;

  // 远侧两条腿（暗、细一点，位置错开才能看出是四条腿）
  leg(ctx, p.bodyBack + 30, hipY - 1, p.legWidth * 0.82, wave(pose, Math.PI), p.coat.shade);
  leg(ctx, p.bodyFront - 15, hipY - 1, p.legWidth * 0.82, wave(pose, 0), p.coat.shade);

  torso(ctx, p, top, bottom);
  tail(ctx, p, top, pose);

  // 近侧两条腿（主色）
  leg(ctx, p.bodyBack + 19, hipY, p.legWidth, wave(pose, 0), p.coat.main);
  leg(ctx, p.bodyFront - 27, hipY, p.legWidth, wave(pose, Math.PI), p.coat.main);

  neck(ctx, p, pose, top, bottom);
  head(ctx, p, pose);
  ctx.restore();
}

function wave(pose: Pose, phase: number): number {
  return Math.sin(pose.legPhase + phase) * pose.legAmp;
}

/** 局部坐标里的椭圆填充（ry 默认等于 rx，即正圆） */
function blob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  ry = r
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r, ry, 0, 0, TAU);
  ctx.fill();
}

/** 地面软阴影：让狗「站」在桌面上而不是浮着 */
function shadow(ctx: CanvasRenderingContext2D, p: DogParams, pose: Pose): void {
  const w = (p.bodyFront - p.bodyBack) * p.scale * 0.58;
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.beginPath();
  ctx.ellipse(pose.x, pose.groundY + 2 * p.scale, w, 5.5 * p.scale, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** 臀 + 胸 + 连接体，背线微拱、腹部在腰部上提 */
function torso(ctx: CanvasRenderingContext2D, p: DogParams, top: number, bottom: number): void {
  const h = top - bottom;
  const rumpX = p.bodyBack + h * 0.4;
  const rumpY = bottom + h * 0.52;
  const rumpR = h * 0.5;
  const chestX = p.bodyFront - h * 0.26;
  const chestY = bottom + h * 0.5;
  const chestR = h * 0.52;

  ctx.fillStyle = p.coat.main;
  ctx.beginPath();
  ctx.moveTo(rumpX, rumpY + rumpR * 0.85);
  ctx.quadraticCurveTo((rumpX + chestX) / 2, top + 2, chestX, chestY + chestR * 0.8);
  ctx.lineTo(chestX + chestR * 0.2, chestY - chestR * 0.75);
  // 腰凹：腹线中点上提，柴犬的腰是细的
  ctx.quadraticCurveTo((rumpX + chestX) / 2 + 2, bottom + h * 0.16, rumpX, rumpY - rumpR * 0.7);
  ctx.closePath();
  ctx.fill();
  blob(ctx, rumpX, rumpY, rumpR, p.coat.main, rumpR * 0.98);
  blob(ctx, chestX, chestY, chestR, p.coat.main, chestR * 1.02);

  // 肚皮奶白：贴着腹线一条，不要飘在躯干中间
  ctx.save();
  ctx.fillStyle = p.coat.cream;
  ctx.beginPath();
  ctx.moveTo(rumpX - 4, bottom + h * 0.05);
  ctx.quadraticCurveTo((rumpX + chestX) / 2, bottom - h * 0.02, chestX + chestR * 0.5, bottom + h * 0.07);
  ctx.quadraticCurveTo((rumpX + chestX) / 2, bottom + h * 0.2, rumpX - 4, bottom + h * 0.17);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 头中心：低头吃饭时整颗头往前下方送，脖子跟着走，不会断开 */
function headCenter(p: DogParams, pose: Pose): { hx: number; hy: number } {
  const dip = pose.headDip;
  return {
    hx: p.headX + p.headR * 0.24 * dip,
    hy: p.headY + pose.headLift - p.headR * 0.66 * dip
  };
}

/** 颈：梯形贴到胸前，不用粗笔触（圆头笔帽会在肩上顶出一个球） */
function neck(
  ctx: CanvasRenderingContext2D,
  p: DogParams,
  pose: Pose,
  top: number,
  bottom: number
): void {
  const h = top - bottom;
  const { hx, hy } = headCenter(p, pose);
  ctx.fillStyle = p.coat.main;
  ctx.beginPath();
  ctx.moveTo(p.bodyFront - h * 0.3, top + 1);
  ctx.lineTo(hx - p.headR * 0.62, hy + p.headR * 0.35);
  ctx.lineTo(hx - p.headR * 0.72, hy - p.headR * 0.85);
  ctx.lineTo(p.bodyFront - h * 0.38, bottom + h * 0.42);
  ctx.closePath();
  ctx.fill();
}

/** 锥形腿：髋宽踝窄，末端一个脚掌椭圆；angle 正 = 向前迈；脚掌落在 y=0 */
function leg(
  ctx: CanvasRenderingContext2D,
  hipX: number,
  hipY: number,
  width: number,
  angle: number,
  color: string
): void {
  const reach = hipY - width * 0.16;
  ctx.save();
  ctx.translate(hipX, hipY);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  const hw = width / 2;
  const aw = width * 0.34;
  ctx.beginPath();
  ctx.moveTo(-hw, -width * 0.1);
  ctx.quadraticCurveTo(-hw * 0.86, -reach * 0.5, -aw, -reach);
  ctx.lineTo(aw, -reach);
  ctx.quadraticCurveTo(hw * 0.86, -reach * 0.5, hw, -width * 0.1);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(aw * 0.4, -reach, width * 0.56, width * 0.34, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** 柴犬卷尾：根部扎进臀部，往后上方起、卷到背线正上方，尾尖奶白 */
function tail(ctx: CanvasRenderingContext2D, p: DogParams, top: number, pose: Pose): void {
  const curl = clamp01(p.tailCurl * (0.85 + pose.tailLift * 0.35));
  const L = 20 + curl * 14;
  ctx.save();
  ctx.translate(p.bodyBack + 22, top - 6);
  ctx.rotate(pose.tailSwing * 0.28);
  ctx.strokeStyle = p.coat.main;
  ctx.lineWidth = p.tailWidth;
  ctx.lineCap = "round";
  // 尖端落在背线上方一点：卷尾是「搭」在背上的，不是飞在天上也不是埋进身体
  const tipX = L * (0.2 + curl * 0.6);
  const tipY = L * (0.3 + curl * 0.25);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-L * 0.5, L * 0.35, -L * 0.15, L * 0.9, tipX, tipY);
  ctx.stroke();
  blob(ctx, tipX, tipY, p.tailWidth * 0.44, p.coat.cream);
  ctx.restore();
}

function head(ctx: CanvasRenderingContext2D, p: DogParams, pose: Pose): void {
  const r = p.headR;
  const { hx, hy } = headCenter(p, pose);

  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(-pose.headTilt);

  ear(ctx, p, pose, -0.5, true);

  blob(ctx, 0, 0, r, p.coat.main, r * 0.94);
  // 脸颊 + 口鼻的奶白区（柴犬的「白口罩」）
  ctx.fillStyle = p.coat.cream;
  ctx.beginPath();
  ctx.ellipse(r * 0.5, -r * 0.3, r * 0.78, r * 0.62, -0.12, 0, TAU);
  ctx.fill();
  // 口鼻：明显向前突出的楔形，不要一个悬空的鼻头
  ctx.beginPath();
  ctx.moveTo(r * 0.62, r * 0.16);
  ctx.quadraticCurveTo(r * 1.5, r * 0.1, r * 1.52, -r * 0.24);
  ctx.quadraticCurveTo(r * 1.45, -r * 0.56, r * 0.6, -r * 0.5);
  ctx.closePath();
  ctx.fill();

  eye(ctx, p, pose, r * 0.44, r * 0.14);
  // 眉点
  ctx.fillStyle = p.coat.cream;
  ctx.beginPath();
  ctx.ellipse(r * 0.2, r * 0.5, r * 0.15, r * 0.1, 0, 0, TAU);
  ctx.fill();

  ctx.fillStyle = p.coat.dark;
  ctx.beginPath();
  ctx.ellipse(r * 1.42, -r * 0.16, r * 0.15, r * 0.12, 0, 0, TAU);
  ctx.fill();

  mouth(ctx, p, pose, r);
  ear(ctx, p, pose, -0.02, false);
  ctx.restore();
}

function eye(
  ctx: CanvasRenderingContext2D,
  p: DogParams,
  pose: Pose,
  x: number,
  y: number
): void {
  const open = 1 - pose.blink;
  if (open > 0.18) {
    ctx.fillStyle = p.coat.dark;
    ctx.beginPath();
    ctx.ellipse(x, y, p.headR * 0.125, p.headR * 0.15 * open, -0.12, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(x + p.headR * 0.045, y + p.headR * 0.045, p.headR * 0.032, 0, TAU);
    ctx.fill();
  } else {
    ctx.strokeStyle = p.coat.dark;
    ctx.lineWidth = p.headR * 0.055;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - p.headR * 0.12, y);
    ctx.quadraticCurveTo(x, y - p.headR * 0.1, x + p.headR * 0.12, y);
    ctx.stroke();
  }
}

function mouth(ctx: CanvasRenderingContext2D, p: DogParams, pose: Pose, r: number): void {
  const open = pose.mouth;
  const cx = r * 1.18;
  const cy = -r * 0.44;
  if (open > 0.05) {
    ctx.fillStyle = p.coat.dark;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.24, r * 0.22 * open + r * 0.05, 0.1, 0, TAU);
    ctx.fill();
    if (pose.tongue > 0.05) {
      ctx.fillStyle = p.coat.tongue;
      ctx.beginPath();
      ctx.ellipse(cx + r * 0.04, cy - r * 0.2 * pose.tongue, r * 0.12, r * 0.24 * pose.tongue + r * 0.04, 0.12, 0, TAU);
      ctx.fill();
    }
  } else {
    ctx.strokeStyle = p.coat.dark;
    ctx.lineWidth = r * 0.05;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.14, cy - r * 0.02);
    ctx.quadraticCurveTo(cx + r * 0.04, cy - r * 0.16, cx + r * 0.2, cy - r * 0.06);
    ctx.stroke();
  }
}

/** 立耳：earLift 0=塌耳朵 1=标准柴犬立耳；far 那只画在头后面 */
function ear(
  ctx: CanvasRenderingContext2D,
  p: DogParams,
  pose: Pose,
  offsetX: number,
  far: boolean
): void {
  const lift = clamp01(p.earLift + pose.earPerk * 0.4 + pose.earTwitch * 0.08);
  const tilt = lerp(1.1, 0.2, lift);
  const len = p.earLen * (far ? 0.88 : 1);
  const w = len * 0.72;
  ctx.save();
  ctx.translate(p.headR * offsetX, p.headR * 0.6);
  ctx.rotate(tilt);
  ctx.fillStyle = far ? p.coat.shade : p.coat.main;
  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.quadraticCurveTo(-w * 0.42, len * 0.58, 0, len);
  ctx.quadraticCurveTo(w * 0.42, len * 0.58, w / 2, 0);
  ctx.closePath();
  ctx.fill();
  if (!far) {
    ctx.fillStyle = "rgba(126,74,46,0.4)";
    ctx.beginPath();
    ctx.moveTo(-w * 0.24, len * 0.12);
    ctx.quadraticCurveTo(0, len * 0.62, w * 0.24, len * 0.12);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
