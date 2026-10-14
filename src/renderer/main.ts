import type { AteEvent, FeedReply, OrganizeEvent, Rect, RoamMode, Stage, UiState } from "../shared/ipc";
import { dogBox, headAnchor } from "./pet/params";
import { bowlBox, drawBowl, makeBowl, type Bowl } from "./pet/bowl";
import { drawShiba } from "./pet/shiba";
import { drawZoneFrames, type ZoneOverlay } from "./pet/zones";
import { Dog, type CarryPoint } from "./pet/state";
import { Effects } from "./pet/effects";
import { makeTrayIcon } from "./pet/tray-icon";
import { mountSettings } from "./settings/ui";

const api = window.pet;
const el = document.getElementById("stage");
const settingsRoot = document.getElementById("settings-root");
const query = new URLSearchParams(location.search);
const view = query.get("view");

// 三种视图共用一份产物：狗窗（交互）、设置窗、装饰绘制层（纯穿透画区域框）
if (view === "settings") {
  document.body.classList.add("view-settings");
  // 不写这一行的话，HTML 的 <title>桌面宠物</title> 会盖掉窗口标题
  document.title = "桌面宠物 · 设置";
  if (settingsRoot) void mountSettings(settingsRoot);
} else if (view === "overlay") {
  bootOverlay();
} else {
  bootPet();
}

function bootPet(): void {
  if (!(el instanceof HTMLCanvasElement)) throw new Error("找不到画布 #stage，渲染层无法启动");
  const maybeCtx = el.getContext("2d");
  if (!maybeCtx) throw new Error("浏览器不支持 Canvas2D");
  // 顶层的 null 收窄不会延续到闭包，这里显式声明成非空类型
  const ctx: CanvasRenderingContext2D = maybeCtx;
  const canvas = el;

  const dog = new Dog();
  const fx = new Effects();
  const debug = query.has("debug");
  const CHIRP = ["汪！", "嘿嘿", "摸摸我", "我在呢"];

  let bowl: Bowl = makeBowl(window.innerWidth, window.innerHeight - 26);
  let feedingLeft = 0;
  let dragHover = false;
  let roamMode: RoamMode = "chase";
  let keepDistance = 220;
  // 整理时把区域中心换算成画布坐标给狗当搬运目标，需要工作区原点
  let workArea: Rect = { x: 0, y: 0, w: 1920, h: 1040 };
  let prev = performance.now();
  let crumbAt = 0;
  // 必须在 resize() 被调用之前声明：resize 里会写它，提前调用会踩 TDZ
  let lastDirty: Rect | null = null;

  function inRect(x: number, y: number, r: { left: number; top: number; right: number; bottom: number }): boolean {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /** 命中区 = 狗（含气泡上方）+ 食盆 + 气泡。区域之外对系统命中测试不存在，点击自然落到下层窗口 */
  function hotRects(): Rect[] {
    const box = dogBox(dog.params, dog.canvasX, dog.anchorY, dog.facing, 28);
    const headroom = { x: box.left, y: box.top - 96, w: box.width, h: 96 };
    const b = bowlBox(bowl, 10);
    const rects: Rect[] = [
      { x: box.left, y: box.top, w: box.width, h: box.height },
      headroom,
      { x: b.left, y: b.top, w: b.width, h: b.height }
    ];
    // 气泡存在时把它的边界框也加入命中区，避免天气/新闻等长文字被裁剪
    const a = headAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
    const bub = fx.bubbleRect(a.x, a.y - dog.params.headR * dog.params.scale * 0.6);
    if (bub) {
      rects.push(bub);
      // 估算可能偏窄（emoji / 中英混排），再叠一帧实际画的框兜底
      const bubReal = fx.bubbleDirty();
      if (bubReal) rects.push(bubReal);
    }
    return rects;
  }

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const groundY = h - 26;
    bowl = makeBowl(w, groundY);
    dog.room = { width: w, groundY, bowlX: bowl.cx };
    lastDirty = null; // 尺寸变了，下一帧整块重画一次
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------- 命中区上报（带迟滞：狗没走出一大步就不重设，避免 SetWindowRgn 每帧触发导致白边闪烁） ----------
  let shapeSig = "";
  let lastCx = -99999;
  let lastCy = -99999;
  function pushShape(): void {
    if (dragging) {
      lastCx = -99999;
      lastCy = -99999; // 松手后强制重贴贴合狗的区域
    } else {
      const cx = dog.canvasX;
      const cy = dog.anchorY;
      // 气泡存在时强制更新命中区（避免天气/新闻等长文字被裁剪）
      const hasBubble = fx.bubbleRect(0, 0) !== null;
      if (!hasBubble && Math.abs(cx - lastCx) < 24 && Math.abs(cy - lastCy) < 24) return;
      lastCx = cx;
      lastCy = cy;
    }
    // 拖动/搬运时把命中区一次性放大到整块画布：区域边缘不再逐帧变化，消除白边闪烁
    const src: Rect[] = (dragging || dog.behavior === "carry")
      ? [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }]
      : hotRects();
    const rects = src.map((r) => ({
      x: Math.floor(r.x / 2) * 2,
      y: Math.floor(r.y / 2) * 2,
      w: Math.ceil(r.w / 2) * 2 + 2,
      h: Math.ceil(r.h / 2) * 2 + 2
    }));
    const sig = JSON.stringify(rects);
    if (sig === shapeSig) return;
    shapeSig = sig;
    api.setHotRegion(rects);
  }

  // ---------- 拖动 = 拎着狗走，松手自由落体 ----------
  let dragging = false;
  let moved = 0;
  let last = { x: 0, y: 0 };
  let grabOffset = { x: 0, y: 0 };
  /** 朝向检查点：横向净位移过迟滞才翻朝向，点击时的 1~2px 微抖绝不能翻 */
  let dragAnchorX = 0;

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const nx = e.clientX + grabOffset.x;
    const ny = e.clientY + grabOffset.y;
    moved += Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y);
    last = { x: e.clientX, y: e.clientY };
    dog.dragTo(nx, ny);
    // 确认是「拖动」（不是点击微抖）后，朝向才跟随拖动方向
    if (moved >= 6) {
      const ddx = nx - dragAnchorX;
      if (Math.abs(ddx) >= 16) {
        dog.setFacing(ddx > 0 ? 1 : -1);
        dragAnchorX = nx;
      }
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // 只有命中区内的鼠标事件会到这里，所以不用再做热区判断
    if (!inRect(e.clientX, e.clientY, dogBox(dog.params, dog.canvasX, dog.anchorY, dog.facing, 12))) return;
    dragging = true;
    moved = 0;
    last = { x: e.clientX, y: e.clientY };
    // 记下抓取点相对脚底的偏移：否则 dragTo 会把脚底瞬移到鼠标位置（点在狗身上就会往上跳一下）
    grabOffset = { x: dog.canvasX - e.clientX, y: dog.anchorY - e.clientY };
    dragAnchorX = dog.canvasX;
    dog.beginDrag();
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    dog.endDrag();
    if (moved < 6) {
      // 检测点击的是哪个部位
      const part = detectClickPart(last.x, last.y);
      if (part === "head") {
        void announceWeather();
      } else if (part === "butt") {
        void triggerOrganize();
      } else {
        petNow();
      }
    }
  });

  document.addEventListener("mouseleave", () => {
    if (!dragging) return;
    dragging = false;
    dog.endDrag();
  });

  function petNow(): void {
    // 成长系统已取消，抚摸不再记账，纯本地反馈
    dog.pet();
    const a = headAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
    fx.burstHearts(a.x, a.y - 6);
    fx.say(CHIRP[Math.floor(Math.random() * CHIRP.length)]);
  }

  /** 检测点击的是狗狗的哪个部位：头 / 屁股 / 其他 */
  function detectClickPart(x: number, y: number): "head" | "butt" | "other" {
    const a = headAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
    const headR = dog.params.headR * dog.params.scale * 0.9;
    const dx = x - a.x;
    const dy = y - a.y;
    if (dx * dx + dy * dy <= headR * headR) return "head";
    const box = dogBox(dog.params, dog.canvasX, dog.anchorY, dog.facing, 0);
    // 屁股区域：边界框的后 1/3（根据朝向）
    const buttX = dog.facing > 0 ? box.left : box.right - box.width / 3;
    if (x >= buttX && x <= buttX + box.width / 3) return "butt";
    return "other";
  }

  /** 点击狗头：播报实时天气 */
  async function announceWeather(): Promise<void> {
    fx.say("看看天气…");
    try {
      const w = await api.getWeather();
      if (w) {
        fx.say(`今天：${w}`, 4);
      } else {
        fx.say("天气查不到，网络不好…", 2.5);
      }
    } catch {
      fx.say("天气查不到，网络不好…", 2.5);
    }
  }

  /** 点击屁股：整理桌面 */
  async function triggerOrganize(): Promise<void> {
    fx.say("汪汪！去整理！");
    try {
      const r = await api.organize();
      if (r.moved.length === 0) {
        fx.say("主人，没有活干！", 3);
      }
    } catch {
      fx.say("整理失败了…", 2.5);
    }
  }

  // 每小时新闻推送
  api.onNews((text: string) => {
    fx.say(`主人有新消息哦：${text}`, 5);
  });

  // ---------- 拖放投喂：食盆一直在命中区里，所以不需要额外开关 ----------
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragHover = true;
  });
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    dragHover = true;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) dragHover = false;
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    dragHover = false;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    // Electron 34 起 File.path 没了，绝对路径只能由 preload 的 webUtils 取
    const paths = files.map((f) => api.pathForFile(f)).filter((p) => p.length > 0);
    if (paths.length === 0) return;
    void api
      .feed(paths)
      .then(report)
      .catch((err) => {
        console.error("[pet] 投喂失败", err);
        fx.say("唔…吃不下");
      });
  });

  // ---------- 开饭 ----------
  function report(reply: FeedReply): void {
    if (reply.ate.length > 0) {
      dog.startMeal(reply.ate.length);
      fx.say(`${reply.ate[0].label}！好吃`, 1.8);
      return;
    }
    if (reply.rejected.length > 0) fx.say(`咬不动：${reply.rejected[0].reason}`, 2.4);
  }

  api.onAte((event: AteEvent) => {
    if (event.items.length === 0) return;
    dog.startMeal(event.items.length);
    fx.say(`${event.items[0].label}！好吃`, 1.8);
  });

  api.onCursor((x, y) => dog.setCursor(x, y));
  api.onRecall(() => {
    dog.recall();
    fx.say("回来啦");
  });

  api.onOrganize((evt: OrganizeEvent) => {
    if (evt.moved <= 0) return;
    // 屏幕物理像素 → 画布坐标（狗窗铺满工作区，原点即工作区原点）
    const toCanvas = (sx: number, sy: number) => ({ x: sx - workArea.x, y: sy - workArea.y });
    const points: CarryPoint[] = [];
    for (const s of evt.steps) {
      const g = toCanvas(s.grabX, s.grabY);
      const d = toCanvas(s.dropX, s.dropY);
      points.push({ x: g.x, y: g.y, fx: g.x, fy: g.y, color: s.color, drop: false, index: s.index, name: s.name });
      points.push({ x: d.x, y: d.y, fx: d.x, fy: d.y, color: s.color, drop: true, index: s.index, name: s.name });
    }
    dog.startCarry(points, (p) => {
      if (p.drop) {
        fx.dropPackage(p.fx, p.fy, p.color);
        api.settleIcon(p.name); // 狗放下了，主进程按名字重查 index 把这个图标写进区域
      } else {
        fx.spillCrumbs(p.fx, p.fy, 3); // 到图标底下扒拉一下
      }
    });
    fx.say(`整理了 ${evt.moved} 个图标`);
  });

  api.onState((state: UiState) => applyState(state));

  function applyState(state: UiState): void {
    feedingLeft = state.feedingSecondsLeft;
    roamMode = state.settings.roamMode;
    keepDistance = state.settings.keepDistance;
    workArea = state.workArea;
    dog.setRoam(roamMode, keepDistance);
    if (roamMode === "stay") fx.say("不跟了，我蹲这儿");
  }

  // ---------- 启动 ----------
  const stageFromUrl = query.get("stage");
  if (stageFromUrl === "puppy" || stageFromUrl === "teen" || stageFromUrl === "adult") {
    dog.setSize(stageFromUrl as Stage);
  }
  void api
    .getState()
    .then((s) => {
      applyState(s);
      // 出生点放在离食盆远一点的地方，方便一眼看出它在追鼠标
      dog.dragTo(Math.round(window.innerWidth * 0.35), window.innerHeight);
      dog.endDrag();
    })
    .catch(() => undefined);
  api.sendTrayIcon(makeTrayIcon());
  fx.say("汪，我来啦");

  // ---------- 主循环：脏矩形重绘 ----------
  function frame(now: number): void {
    const dt = Math.min((now - prev) / 1000, 0.05);
    prev = now;

    const pose = dog.update(dt);
    fx.update(dt);
    if (dog.behavior === "eat" && now - crumbAt > 260) {
      crumbAt = now;
      const a = headAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
      fx.spillCrumbs(a.x, a.y + 8, 2);
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const dogR = dogBox(pose.params, pose.x, pose.groundY, pose.dir, 30);
    const bowlR = bowlBox(bowl, 14);
    const parts = [
      { x: dogR.left, y: dogR.top - 100, w: dogR.width, h: dogR.height + 100 },
      { x: bowlR.left, y: bowlR.top, w: bowlR.width, h: bowlR.height }
    ];
    const particle = fx.dirty();
    if (particle) parts.push(particle);
    // 气泡是不受狗框宽度限制的白色圆角条：必须把它的实际区域也纳入脏区，
    // 否则横向溢出狗框的部分在气泡消失后永远清不掉，形成「盖住狗」的白色残影
    const bubDrawn = fx.bubbleDirty();
    if (bubDrawn) parts.push(bubDrawn);
    if (debug) parts.push({ x: 0, y: 0, w: 260, h: 22 });

    let dirty = { x: w, y: h, w: 0, h: 0 };
    const grow = (r: Rect): void => {
      const x2 = Math.max(dirty.x + dirty.w, r.x + r.w);
      const y2 = Math.max(dirty.y + dirty.h, r.y + r.h);
      dirty = {
        x: Math.min(dirty.x, r.x),
        y: Math.min(dirty.y, r.y),
        w: x2 - Math.min(dirty.x, r.x),
        h: y2 - Math.min(dirty.y, r.y)
      };
    };
    for (const r of parts) grow(r);
    if (lastDirty) grow(lastDirty);
    if (dirty.w <= 0 || dirty.h <= 0) {
      requestAnimationFrame(frame);
      return;
    }
    ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
    lastDirty = { x: dirty.x, y: dirty.y, w: dirty.w, h: dirty.h };

    drawShiba(ctx, pose);
    // 盆画在狗之后：低头吃的时候口鼻被盆沿挡住一点，看着才像真埋进盆里
    drawBowl(ctx, bowl, {
      kibble: dog.behavior === "eat" ? 0 : 2,
      highlight: feedingLeft > 0 || dragHover
    });
    const a = headAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
    fx.drawBubble(ctx, a.x, a.y - pose.params.headR * pose.params.scale * 0.6);
    fx.drawCrumbs(ctx);
    fx.drawPackages(ctx);
    fx.drawHearts(ctx);

    pushShape();

    if (debug) {
      ctx.strokeStyle = "rgba(255,0,80,0.9)";
      ctx.lineWidth = 1;
      for (const r of hotRects()) ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.font = "11px Consolas, monospace";
      ctx.textAlign = "left";
      ctx.fillText(
        `${dog.behavior} ${roamMode} x=${dog.canvasX.toFixed(0)} dir=${dog.facing} keep=${keepDistance} feed=${feedingLeft}s`,
        6,
        14
      );
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * 装饰绘制层视图：只画区域框。它在一栋全程点击穿透的窗里，
 * 不受狗窗 setShape 的绘制裁剪影响，能把框画到整块屏幕任意位置。
 * 静态内容，rAF 轻量重画即可（几个矩形，开销可忽略），隐藏时自动节流。
 */
function bootOverlay(): void {
  const c = document.getElementById("stage");
  if (!(c instanceof HTMLCanvasElement)) return;
  const g = c.getContext("2d");
  if (!g) return;
  const ctx: CanvasRenderingContext2D = g;
  const canvas: HTMLCanvasElement = c;

  let zones: ZoneOverlay[] = [];
  let wa: Rect = { x: 0, y: 0, w: 1920, h: 1040 };

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  function apply(s: UiState): void {
    wa = s.workArea;
    zones = s.config.zones.map((z) => ({ rect: z.rect, color: z.color, name: z.name, enabled: z.enabled }));
  }
  api.onState(apply);
  void api
    .getState()
    .then(apply)
    .catch(() => undefined);

  (function loop(): void {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    drawZoneFrames(ctx, zones, wa);
    requestAnimationFrame(loop);
  })();
}
