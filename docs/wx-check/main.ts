/**
 * 临时验收用（不算产品代码）：把「天气那一下」到底有多显眼量出数字。
 *
 * 做法：用真实的行为机 + 真实的绘制函数 + 真实的 WeatherFx，同一帧画两遍
 * （一遍不叠天气、一遍叠），逐像素比 alpha 差。alpha 差就是合成到桌面上
 * 之后「变了多少」——狗窗是透明的，10% alpha 的东西压在你桌布上基本看不出来，
 * 所以这个数比「有没有画」有用。
 */
import { Dog } from "../../src/renderer/pet/state";
import { chestAnchor, dogBox, headAnchor, mouthAnchor } from "../../src/renderer/pet/params";
import { drawShiba } from "../../src/renderer/pet/shiba";
import { Effects } from "../../src/renderer/pet/effects";
import { WeatherFx } from "../../src/renderer/pet/weather";
import type { WeatherMood } from "../../src/shared/weather";
import type { Pose } from "../../src/renderer/pet/pose";

/** 画布故意开宽（接近真实工作区宽度），不然「嘴前方」会因为放不下而退回头顶，量不到真正想验的东西 */
const W = 1000;
const H = 360;

type Rect = { x: number; y: number; w: number; h: number };
type BubbleRow = {
  mood: string;
  oldW: number;
  newW: number;
  /** 这一帧天气真正改动过的像素数（分母：被气泡压掉多少要拿它比） */
  fxTotal: number;
  /** 狗身上画了颜色的像素数（分母） */
  dogTotal: number;
  /** 气泡盖掉的天气动画像素 */
  oldCoverFx: number;
  newCoverFx: number;
  /** 气泡盖掉的狗身像素 */
  oldCoverDog: number;
  newCoverDog: number;
  oldRect: Rect;
  newRect: Rect;
  /** 核对用：狗脚底、朝向、嘴锚点、头顶锚点 */
  footX: number;
  dir: number;
  mouth: { x: number; y: number };
  head: { x: number; y: number };
};

function ctxOf(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("量不了：这个浏览器没有 2D 画布");
  return g;
}

/** 矩形内按掩码数像素（矩形超出画布就夹住） */
function countIn(mask: Uint8Array, r: Rect): number {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(W, Math.ceil(r.x + r.w));
  const y1 = Math.min(H, Math.ceil(r.y + r.h));
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += mask[y * W + x];
  return n;
}

/**
 * 量「气泡把动画盖住了多少」——按像素数，不按矩形面积：
 * 狗是个不规则剪影，包围盒会虚报；天气那层也是只有几条雨丝，矩形交集同样虚报。
 * old = 原来那种一行、挂在头顶；new = 现在这种短句子、挂在嘴前方。
 */
function bubble(mood: WeatherMood, text: string, newText: string): BubbleRow {
  const dog = new Dog();
  dog.room = { width: W, groundY: H - 60, bowlX: W - 40 };
  dog.setSize("adult");
  dog.setRoam("stay", 380);
  for (let i = 0; i < 200; i++) dog.update(1 / 60);
  // 把狗放到画面中间：贴碗边那种位置「嘴前方」必然顶到屏幕边、会自动退回头顶，量不到想验的东西
  dog.dragTo(Math.round(W / 2), H - 60);
  const pose = dog.update(1 / 60) as Pose;
  const anchor = headAnchor(pose.params, pose.x, pose.groundY, pose.dir);
  const fx = new WeatherFx();
  fx.start(mood);
  fx.update(1 / 60, anchor, { x: pose.x, y: pose.groundY }, pose.dir);

  // 同一帧画两遍：不叠天气 / 叠天气，差出来的就是「这一帧的动画像素」
  const base = canvas();
  const withFx = canvas();
  const gb = ctxOf(base);
  const go = ctxOf(withFx);
  gb.clearRect(0, 0, W, H);
  drawShiba(gb, pose);
  const patched = { ...pose };
  fx.pose(patched);
  go.clearRect(0, 0, W, H);
  drawShiba(go, patched);
  fx.draw(go);
  const a = gb.getImageData(0, 0, W, H).data;
  const b = go.getImageData(0, 0, W, H).data;
  const fxDiff = new Uint8Array(W * H);
  const dogPix = new Uint8Array(W * H);
  let fxTotal = 0;
  let dogTotal = 0;
  for (let i = 0, p = 3; i < W * H; i++, p += 4) {
    if (Math.abs(a[p] - b[p]) >= 40) {
      fxDiff[i] = 1;
      fxTotal++;
    }
    if (a[p] > 0) {
      dogPix[i] = 1;
      dogTotal++;
    }
  }

  // 两种画法各自的真实气泡框（bubbleDirty 就是它这一帧占了哪一块）
  const stage = canvas();
  const ctx = ctxOf(stage);
  ctx.font = "600 13px 'Microsoft YaHei', system-ui, sans-serif";
  const ef1 = new Effects();
  ef1.say(text, 4.5);
  const oldAy = anchor.y - pose.params.headR * pose.params.scale * 0.6;
  ef1.drawBubble(ctx, anchor.x, oldAy);
  const oldRect = ef1.bubbleDirty()!;

  const ef2 = new Effects();
  ef2.say(newText, 4.5, "front");
  const m = mouthAnchor(pose.params, pose.x, pose.groundY, pose.dir);
  // 和 src/renderer/main.ts 的 bubbleAnchor() 同一套规则：横向基准取狗身朝前的那条边，
  // 只往朝的那一边放，放不下就退回头顶
  const body = dogBox(pose.params, pose.x, pose.groundY, pose.dir, 0);
  const baseX = pose.dir > 0 ? body.right : body.left;
  const estW = ef2.bubbleRect(0, 0)?.w ?? 130;
  const near = baseX + pose.dir * 16;
  const fitsFront = pose.dir > 0 ? near + estW <= W - 6 : near - estW >= 6;
  ctx.clearRect(0, 0, W, H);
  if (fitsFront) ef2.drawBubble(ctx, baseX, m.y, pose.dir);
  else ef2.drawBubble(ctx, anchor.x, oldAy);
  const newRect = ef2.bubbleDirty()!;

  return {
    mood,
    oldW: Math.round(oldRect.w),
    newW: Math.round(newRect.w),
    fxTotal,
    dogTotal,
    oldCoverFx: countIn(fxDiff, oldRect),
    newCoverFx: countIn(fxDiff, newRect),
    oldCoverDog: countIn(dogPix, oldRect),
    newCoverDog: countIn(dogPix, newRect),
    oldRect,
    newRect,
    footX: pose.x,
    dir: pose.dir,
    mouth: m,
    head: anchor
  };
}

/** 老文案（一行拉很长）与新文案（只报温度和中文天气词），今天真实数据 */
const WEATHER_TEXT = "🌫 16~24℃ · Smoky haze · 湿度44% · 风19km/h";
const WEATHER_TEXT_NEW = "🌫 现在 18℃ · 雾霾";


type Row = {
  mood: string;
  frames: number;
  /** 至少有一帧 alpha 变化 >= 40/255（≈16%）的像素数最大值 */
  peak40: number;
  /** 变化 >= 90/255（≈35%，一眼能看见）的像素数最大值 */
  peak90: number;
  /** 全帧里最大的 alpha 变化 */
  maxDelta: number;
  /** 只看狗本身（不含飘在狗外的粒子/雾带）改了多少像素 */
  dogChanged: number;
};

function canvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  return c;
}

function measure(mood: WeatherMood): Row {
  const dog = new Dog();
  dog.room = { width: W, groundY: H - 60, bowlX: W - 40 };
  dog.setSize("adult");
  dog.setRoam("stay", 380);
  const base = canvas();
  const over = canvas();
  const gb = base.getContext("2d", { willReadFrequently: true })!;
  const go = over.getContext("2d", { willReadFrequently: true })!;
  // 先跑 120 帧让待机稳定（眨眼是随机的，会让差异虚高）
  for (let i = 0; i < 120; i++) dog.update(1 / 60);

  const fx = new WeatherFx();
  fx.start(mood);
  let peak40 = 0;
  let peak90 = 0;
  let maxDelta = 0;
  let dogChanged = 0;
  let frames = 0;
  for (let guard = 0; guard < 400 && fx.active; guard++) {
    const pose = dog.update(1 / 60);
    const anchor = headAnchor(pose.params, pose.x, pose.groundY, pose.dir);
    fx.update(1 / 60, anchor, { x: pose.x, y: pose.groundY }, pose.dir);
    gb.clearRect(0, 0, W, H);
    drawShiba(gb, pose);
    const patched = { ...pose };
    fx.pose(patched);
    go.clearRect(0, 0, W, H);
    drawShiba(go, patched);
    fx.draw(go);
    const a = gb.getImageData(0, 0, W, H).data;
    const b = go.getImageData(0, 0, W, H).data;
    let n40 = 0;
    let n90 = 0;
    let mx = 0;
    let body = 0;
    for (let p = 3; p < a.length; p += 4) {
      const d = Math.abs(a[p] - b[p]);
      if (d === 0) continue;
      if (d > mx) mx = d;
      if (d >= 40) n40++;
      if (d >= 90) n90++;
      // 狗身范围（横向）：差值出在这儿 = 动作本身改了，不是飘在外面的粒子
      const px = (p / 4) % W;
      if (d >= 40 && px > pose.x - 130 && px < pose.x + 130) body++;
    }
    frames++;
    peak40 = Math.max(peak40, n40);
    peak90 = Math.max(peak90, n90);
    maxDelta = Math.max(maxDelta, mx);
    dogChanged = Math.max(dogChanged, body);
  }
  return { mood, frames, peak40, peak90, maxDelta, dogChanged };
}

declare global {
  interface Window {
    __wxRows: Row[];
    __wxText: string;
    __wxLive: (mood: WeatherMood) => Row;
    __wxBubble: BubbleRow[];
    __wxBubbleText: string;
    __wxWeatherText: string;
    __wxHit: { part: string; inside: number; total: number }[];
  }
}

const MOODS: WeatherMood[] = ["thunder", "snow", "rain", "haze", "wind", "heat", "cold", "clear", "other"];
const rows = MOODS.map(measure);
const bubbleRows = MOODS.map((m) => bubble(m, WEATHER_TEXT, WEATHER_TEXT_NEW));

/**
 * 「点这个部位」到底点没点在画出来的狗上：拿真实绘制结果，
 * 数判定区域里有多少比例是真画着狗的像素（区域和 detectClickPart 用同一套算法）。
 */
function hitCoverage(): { part: string; inside: number; total: number }[] {
  const dog = new Dog();
  dog.room = { width: W, groundY: H - 60, bowlX: W - 40 };
  dog.setSize("adult");
  dog.setRoam("stay", 380);
  for (let i = 0; i < 200; i++) dog.update(1 / 60);
  dog.dragTo(Math.round(W / 2), H - 60);
  const pose = dog.update(1 / 60) as Pose;
  const g = ctxOf(canvas());
  drawShiba(g, pose);
  const d = g.getImageData(0, 0, W, H).data;
  const on = (x: number, y: number): boolean => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= W || py >= H) return false;
    return d[(py * W + px) * 4 + 3] > 0;
  };
  const a = headAnchor(pose.params, pose.x, pose.groundY, pose.dir);
  const chest = chestAnchor(pose.params, pose.x, pose.groundY, pose.dir);
  const box = dogBox(pose.params, pose.x, pose.groundY, pose.dir, 0);
  const buttLeft = pose.dir > 0 ? box.left : box.right - box.width / 3;
  const zones = [
    { part: "狗头圆（点天气）", cx: a.x, cy: a.y, r: pose.params.headR * pose.params.scale * 0.9 },
    { part: "前胸口圆（点新闻）", cx: chest.x, cy: chest.y, r: chest.r }
  ];
  const out = zones.map((z) => {
    let inside = 0;
    let total = 0;
    for (let dy = -Math.ceil(z.r); dy <= Math.ceil(z.r); dy++) {
      for (let dx = -Math.ceil(z.r); dx <= Math.ceil(z.r); dx++) {
        if (Math.hypot(dx, dy) > z.r) continue;
        total++;
        if (on(z.cx + dx, z.cy + dy)) inside++;
      }
    }
    return { part: z.part, inside, total };
  });
  let bIn = 0;
  let bTot = 0;
  for (let y = Math.floor(box.top); y <= box.bottom; y++) {
    for (let x = Math.floor(buttLeft); x <= buttLeft + box.width / 3; x++) {
      bTot++;
      if (on(x, y)) bIn++;
    }
  }
  out.push({ part: "屁股 1/3 矩形（点整理）", inside: bIn, total: bTot });
  return out;
}



window.__wxRows = rows;
window.__wxLive = measure;
window.__wxHit = hitCoverage();
window.__wxBubble = bubbleRows;
window.__wxWeatherText = `${WEATHER_TEXT}  →  ${WEATHER_TEXT_NEW}`;
window.__wxText = rows
  .map((r) => `${r.mood.padEnd(8)} 帧${String(r.frames).padStart(3)} 最大Δalpha=${String(r.maxDelta).padStart(3)} ≥16%像素=${String(r.peak40).padStart(5)} ≥35%像素=${String(r.peak90).padStart(5)} 狗身内=${String(r.dogChanged).padStart(5)}`)
  .join("\n");
window.__wxBubbleText = bubbleRows
  .map((b) => `${b.mood.padEnd(8)} 宽 ${String(b.oldW).padStart(3)}→${String(b.newW).padStart(3)} 盖掉动画 ${String(b.oldCoverFx).padStart(4)}/${b.fxTotal}→${String(b.newCoverFx).padStart(3)}/${b.fxTotal} 压在狗上 ${String(b.oldCoverDog).padStart(4)}/${b.dogTotal}→${String(b.newCoverDog).padStart(4)}/${b.dogTotal}`)
  .join("\n");
