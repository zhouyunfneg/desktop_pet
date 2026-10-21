import type { AteEvent, FeedReply, NewsReply, OrganizeEvent, Rect, RoamMode, Stage, UiState, WeatherReply } from "../shared/ipc";
import { MAX_BATCH } from "../shared/feed-guard";
import { DEFAULT_PET_NAME } from "../shared/normalize";
import { chestAnchor, dogBox, headAnchor, mouthAnchor, shapeNeedsReport, type ShapeStamp } from "./pet/params";
import { bowlBox, drawBowl, makeBowl, type Bowl } from "./pet/bowl";
import { drawShiba } from "./pet/shiba";
import { drawZoneFrames, type ZoneOverlay } from "./pet/zones";
import { Dog, type CarryPoint } from "./pet/state";
import { Effects } from "./pet/effects";
import { WeatherFx } from "./pet/weather";
import { makeTrayIcon } from "./pet/tray-icon";
import { createPetMenu } from "./pet/menu";
import { createFoldPanel } from "./pet/fold-panel";
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
  /** 天气效果：点狗头查到天气才播一次，不常驻、不进状态机 */
  const wx = new WeatherFx();
  const debug = query.has("debug");
  const CHIRP = ["汪！", "嘿嘿", "摸摸我", "我在呢"];

  let bowl: Bowl = makeBowl(window.innerWidth, window.innerHeight - 26);
  let dragHover = false;
  // 收纳确认面板开着：命中区要放大到整块画布，不然点面板外收不到事件（面板比狗身宽）
  let foldOpen = false;
  let roamMode: RoamMode = "chase";
  let keepDistance = 380; // 与主进程默认值保持一致，拿到存档前也不会用错距离
  // 狗的名字：只用在收纳确认面板的标题上（右键菜单那行由主进程随菜单快照一起递过来）
  let petName = DEFAULT_PET_NAME;
  // 整理时把区域中心换算成画布坐标给狗当搬运目标，需要工作区原点
  let workArea: Rect = { x: 0, y: 0, w: 1920, h: 1040 };
  let prev = performance.now();
  let crumbAt = 0;
  // 必须在 resize() 被调用之前声明：resize 里会写它，提前调用会踩 TDZ
  let lastDirty: Rect | null = null;

  function inRect(x: number, y: number, r: { left: number; top: number; right: number; bottom: number }): boolean {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  /** 两个矩形的并集，脏区累加用 */
  function combine(a: Rect, b: Rect): Rect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      w: Math.max(a.x + a.w, b.x + b.w) - x,
      h: Math.max(a.y + a.h, b.y + b.h) - y
    };
  }

  /**
   * 气泡该画在哪儿。(x,y) = 小尾巴尖指的位置，side = 挂在锚点的哪一侧（0 = 正上方）。
   * 平时（抚摸、开饭、新闻）贴着狗头顶；报天气那句走嘴前方 —— 压在狗头上会把脸上的
   * 表情和天气那层粒子一起挡掉，看着就像没触发。
   */
  function bubbleAnchor(): { x: number; y: number; side: -1 | 0 | 1 } {
    const a = headAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
    const above = { x: a.x, y: a.y - dog.params.headR * dog.params.scale * 0.6, side: 0 as const };
    if (fx.bubblePlace !== "front") return above;
    const m = mouthAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
    // 横向基准用「狗身体朝前的那条边」而不是嘴锚点：嘴锚点还在鼻头往里一点，
    // 拿它当基准气泡会压住鼻尖（实测压到 172 个狗身像素）
    const body = dogBox(dog.params, dog.canvasX, dog.anchorY, dog.facing, 0);
    const baseX = dog.facing > 0 ? body.right : body.left;
    // 宽度按估算值来（这时还没画），够决定放不放得下
    const estW = fx.bubbleRect(0, 0)?.w ?? 130;
    const edge = 6;
    const near = baseX + dog.facing * 16;
    const fitsFront = dog.facing > 0 ? near + estW <= window.innerWidth - edge : near - estW >= edge;
    // 只往「朝的那一边」放：反向会正好压在狗自己身上（嘴后面就是头和身子）。
    // 贴到屏幕边上放不下时宁可退回头顶，也别把句子糊在狗脸上
    if (!fitsFront) return above;
    return { x: baseX, y: Math.max(34, m.y), side: dog.facing };
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
    const bubPos = bubbleAnchor();
    const bub = fx.bubbleRect(bubPos.x, bubPos.y, bubPos.side);
    if (bub) {
      rects.push(bub);
      // 估算可能偏窄（emoji / 中英混排），再叠一帧实际画的框兜底
      const bubReal = fx.bubbleDirty();
      if (bubReal) rects.push(bubReal);
    }
    // 天气那几秒的雨丝/雪片比狗身宽，窗口形状不覆盖到就会被整齐切掉
    const wxBox = wx.paintBox();
    if (wxBox) rects.push(wxBox);
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
  let lastStamp: ShapeStamp | null = null;
  function pushShape(): void {
    // 菜单开着就什么都不报：主进程此时把命中区固定在整块画布，
    // 报回去只会让面板被 SetWindowRgn 裁掉（菜单看起来没弹出来）
    if (petMenu.isOpen()) return;
    if (dragging) {
      lastStamp = null; // 松手后强制重贴贴合狗的区域
    } else {
      const now: ShapeStamp = { x: dog.canvasX, y: dog.anchorY, dir: dog.facing };
      // 气泡或天气效果在播时强制重报（两者的框都可能超出上一次贴的形状，会被裁掉）
      const mustReport = fx.bubbleRect(0, 0) !== null || wx.active;
      if (!mustReport && !shapeNeedsReport(lastStamp, now)) return;
      lastStamp = now;
    }
    // 拖动/搬运/确认面板开着时把命中区一次性放大到整块画布：区域边缘不再逐帧变化，消除白边闪烁
    const src: Rect[] = (dragging || dog.behavior === "carry" || foldOpen)
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

  // ---------- 叼着走：真图标交给主进程藏到屏幕外，画面上由狗嘴那张假图标代替 ----------
  // 不直接挪真图标跟着嘴走：桌面只会把图标停在 76×101 的格点上，看到的是图标在抽风
  let carriedKey: string | null = null;
  function syncCarry(): void {
    const name = dog.carriedName;
    if (name === carriedKey) return;
    carriedKey = name;
    if (!name) {
      // 嘴上的假图标缩没；主进程那边：已经 settle 过就是空操作，
      // 中途被拎走/叫回来才把藏起来的真图标放回原位
      fx.releaseHeld();
      api.cancelCarry();
      return;
    }
    const category = dog.carriedCategory ?? "";
    const color = dog.carriedColor ?? "#9AA0A6";
    void api
      .grabIcon(name)
      .then((hidden) => {
        // 真图标没藏成功就别画假的：桌面上那一个还看得见，画两个就穿帮了
        // 回调回来时狗可能已经叼上下一个／被拎走，所以要再核对一次名字
        if (hidden && dog.carriedName === name) fx.setHeld({ category, color });
      })
      .catch(() => undefined);
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
      } else if (part === "chest") {
        void announceNews();
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

  /** 检测点击的是狗狗的哪个部位：头 / 前胸口 / 屁股 / 其他 */
  function detectClickPart(x: number, y: number): "head" | "chest" | "butt" | "other" {
    const a = headAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
    const headR = dog.params.headR * dog.params.scale * 0.9;
    const dx = x - a.x;
    const dy = y - a.y;
    if (dx * dx + dy * dy <= headR * headR) return "head";
    // 前胸：胸口那一块圆，和头圆、屁股区域都不重，所以三个部位分得开
    const c = chestAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
    const cd = Math.hypot(x - c.x, y - c.y);
    if (cd <= c.r) return "chest";
    const box = dogBox(dog.params, dog.canvasX, dog.anchorY, dog.facing, 0);
    // 屁股区域：边界框的后 1/3（根据朝向）
    const buttX = dog.facing > 0 ? box.left : box.right - box.width / 3;
    if (x >= buttX && x <= buttX + box.width / 3) return "butt";
    return "other";
  }

  /**
   * 点击狗头：报一句天气，同时演「对应这个天气」的那一下动作（下雨就抖水、打雷就一惊）。
   * 一次性，几秒后自己停；查不到就只说查不到，不乱演。
   */
  async function announceWeather(): Promise<void> {
    fx.say("看看天气…");
    let r: WeatherReply;
    try {
      r = await api.getWeather();
    } catch {
      r = { text: "", mood: "other" };
    }
    if (!r.text) {
      fx.say("天气查不到，网络不好…", 2.5);
      return;
    }
    fx.say(r.text, 4.5, "front");
    wx.start(r.mood);
  }

  /**
   * 点击前胸口：播一条今天的新闻。原来是每小时自动推一条（一天里自己打断你好几次），
   * 现在改成想听就点一下；同一天里每条只播一次，点完一批会自动开下一轮。
   */
  async function announceNews(): Promise<void> {
    fx.say("今天的新鲜事…");
    let r: NewsReply;
    try {
      r = await api.getNews();
    } catch {
      r = { text: "", total: 0, left: 0, wrapped: false };
    }
    if (!r.text) {
      fx.say("新闻查不到，网络不好…", 2.5);
      return;
    }
    // 长句子交给气泡自己折行（头顶那种最多三行），这里只管说什么
    fx.say(`主人，${r.text}`, r.left > 0 ? 6.5 : 5.5);
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

  // ---------- 右键菜单（自绘玻璃面板，样式见 styles.css 的 .pm-*） ----------
  const mugUrl = makeTrayIcon(40);
  const petMenu = createPetMenu(
    () => mugUrl,
    (action) => api.pickMenu(action)
  );
  api.onMenu((request) => {
    if (request) petMenu.show(request);
    else petMenu.hide();
  });

  // ---------- 收纳确认：真要动文件之前，先把清单摊开让她点头 ----------
  const foldPanel = createFoldPanel(
    () => mugUrl,
    () => ({ x: dog.canvasX, y: dog.anchorY }),
    () => petName
  );
  api.onFoldAsk((preview) => {
    foldOpen = true;
    foldPanel.show(
      preview,
      () => {
        foldOpen = false;
        void api.foldRun().catch((err) => {
          console.error("[pet] 收纳失败", err);
          fx.say("唔…搬不动");
        });
      },
      () => {
        foldOpen = false;
        fx.say("那先不动它们");
      }
    );
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
    // 被单次上限截掉的部分必须说出来，不然用户以为整批都喂进去了
    const overflowHint =
      reply.overflow > 0 ? `剩下 ${reply.overflow} 个没吃，一次最多 ${MAX_BATCH} 个` : "";
    if (reply.ate.length > 0) {
      dog.startMeal(reply.ate.length);
      fx.say(overflowHint || `${reply.ate[0].label}！好吃`, overflowHint ? 3.2 : 1.8);
      return;
    }
    if (overflowHint) {
      fx.say(overflowHint, 3.2);
      return;
    }
    if (reply.rejected.length > 0) fx.say(`咬不动：${reply.rejected[0].reason}`, 2.4);
  }

  api.onAte((event: AteEvent) => {
    if (event.items.length === 0) {
      // 一个都没吃下：只在主进程给了理由时吭一声，别自己瞎猜
      if (event.note) fx.say(event.note, 2.8);
      return;
    }
    dog.startMeal(event.items.length);
    // 主进程交代了附加信息（比如被单次上限截掉）就先说这个，否则报「好吃」
    fx.say(event.note ?? `${event.items[0].label}！好吃`, event.note ? 3.2 : 1.8);
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
      points.push({
        x: g.x,
        y: g.y,
        fx: g.x,
        fy: g.y,
        color: s.color,
        category: s.category,
        drop: false,
        index: s.index,
        name: s.name
      });
      points.push({
        x: d.x,
        y: d.y,
        fx: d.x,
        fy: d.y,
        color: s.color,
        category: s.category,
        drop: true,
        index: s.index,
        name: s.name
      });
    }
    const last = points[points.length - 1];
    dog.startCarry(points, (p) => {
      if (p.drop) {
        // 真图标这一刻才被写进落点（收纳那一步是这一刻才真的搬文件），同时嘴上的假图标开始缩没
        api.settleIcon(p.name);
        // 收纳跑完接着排整齐：两段共用同一套叼运动画，分两批是因为文件搬走之后落点会变
        if (p === last && evt.phase === "fold") {
          fx.say(`收好 ${evt.moved} 个文件，我再摆摆整齐`);
          window.setTimeout(() => void api.columnsRun().catch(() => undefined), 400);
        }
        return;
      }
      fx.spillCrumbs(p.fx, p.fy, 3); // 到图标底下扒拉一下
    });
    fx.say(evt.phase === "fold" ? `我把 ${evt.moved} 个文件收进文件夹` : `整理了 ${evt.moved} 个图标`);
  });

  api.onState((state: UiState) => applyState(state));

  function applyState(state: UiState): void {
    roamMode = state.settings.roamMode;
    keepDistance = state.settings.keepDistance;
    petName = state.settings.petName;
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
    // 天气效果：只借这几秒改改姿态数字 + 撒粒子，不进状态机（狗照常追鼠标、吃饭、搬运）
    const head = headAnchor(pose.params, pose.x, pose.groundY, pose.dir);
    wx.update(dt, head, { x: pose.x, y: pose.groundY }, pose.dir);
    wx.pose(pose);
    // 叼/放的动作发生在 dog.update 里，所以假图标的增删要在绘制之前同步
    syncCarry();
    if (dog.behavior === "eat" && now - crumbAt > 260) {
      crumbAt = now;
      const a = headAnchor(dog.params, dog.canvasX, dog.anchorY, dog.facing);
      fx.spillCrumbs(a.x, a.y + 8, 2);
    }

    const dogR = dogBox(pose.params, pose.x, pose.groundY, pose.dir, 30);
    const bowlR = bowlBox(bowl, 14);
    const parts = [
      { x: dogR.left, y: dogR.top - 100, w: dogR.width, h: dogR.height + 100 },
      { x: bowlR.left, y: bowlR.top, w: bowlR.width, h: bowlR.height }
    ];
    const particle = fx.dirty();
    if (particle) parts.push(particle);
    // 假图标跟着嘴挪，也弹跳、也会缩没，脏区按它上一帧实际画的框算
    const heldRect = fx.heldDirty();
    if (heldRect) parts.push(heldRect);
    // 天气那层会飘到狗框外面，而且停掉之后还要多清一帧，旧位置的雨丝雪片才擦得干净
    const wxRect = wx.dirty();
    if (wxRect) parts.push(wxRect);
    // 气泡是不受狗框宽度限制的白色圆角条：必须把它的实际区域也纳入脏区，
    // 否则横向溢出狗框的部分在气泡消失后永远清不掉，形成「盖住狗」的白色残影
    const bubDrawn = fx.bubbleDirty();
    if (bubDrawn) parts.push(bubDrawn);
    if (debug) parts.push({ x: 0, y: 0, w: 260, h: 22 });

    // 本帧内容区 = 狗框 + 盆 + 粒子 + 气泡 + 天气（+ 调试框）
    let content: Rect | null = null;
    for (const r of parts) content = content ? combine(content, r) : { x: r.x, y: r.y, w: r.w, h: r.h };
    if (!content || content.w <= 0 || content.h <= 0) {
      requestAnimationFrame(frame);
      return;
    }
    // 要清的是「本帧内容 ∪ 上一帧内容」：只记上一帧、不把上一帧的并集再攒进来，
    // 否则脏区单调增长，跑一圈就退化成每帧整屏清除，脏矩形优化等于白做
    const dirty = lastDirty ? combine(content, lastDirty) : content;
    ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
    lastDirty = content;

    drawShiba(ctx, pose);
    // 盆画在狗之后：低头吃的时候口鼻被盆沿挡住一点，看着才像真埋进盆里
    drawBowl(ctx, bowl, {
      kibble: dog.behavior === "eat" ? 0 : 2,
      highlight: dragHover
    });
    // 天气的雨丝/雪/闪光压在狗和盆上（雨是下在它们头上的），但要在气泡之前：字得看得清
    wx.draw(ctx);
    // 气泡位置跟着 bubbleAnchor() 走：报天气那句画在嘴前方，不压狗脸也不压天气粒子
    const bubPos = bubbleAnchor();
    fx.drawBubble(ctx, bubPos.x, bubPos.y, bubPos.side);
    fx.drawCrumbs(ctx);
    // 嘴里的假图标：咬在门牙前面一点，尺寸跟着狗的体型缩放
    const mouth = mouthAnchor(pose.params, pose.x, pose.groundY, pose.dir);
    fx.drawHeld(
      ctx,
      mouth.x + pose.dir * pose.params.scale * 3,
      mouth.y,
      pose.dir,
      Math.max(13, pose.params.headR * pose.params.scale * 0.6)
    );
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
        `${dog.behavior} ${roamMode} x=${dog.canvasX.toFixed(0)} dir=${dog.facing} keep=${keepDistance}`,
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
