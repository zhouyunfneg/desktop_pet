import type { MenuAction, MenuEntry, MenuGroup, MenuRequest } from "../../shared/ipc";

/**
 * 狗身上的右键菜单：渲染层自绘的玻璃面板。
 *
 * 为什么不用 Electron 原生 Menu：原生菜单由系统绘制，网页样式一点都碰不到，
 * 拿不到 Solid Glass 那套边缘材质。
 *
 * 两个平台约束写在明处：
 * - 狗窗是 focusable:false（WS_EX_NOACTIVATE），摸它不会抢走打字焦点，
 *   代价是收不到键盘事件，所以只能靠鼠标点、点外面收起，没有方向键与 Esc；
 * - 面板可能比狗身位宽，弹出期间主进程把命中区放大到整块画布，
 *   点外面才收得到事件（也才有机会把它关掉）。
 */

/** 面板宽度与边缘留白，用来算翻转（宽度需与 styles.css 的 .pm-pane 一致） */
const PANE_W = 252;
const EDGE = 8;

export interface PetMenu {
  show(request: MenuRequest): void;
  hide(): void;
  isOpen(): boolean;
}

function item(entry: MenuEntry, onPick: (action: MenuAction) => void): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "pm-item";
  btn.setAttribute("data-slot", "button");
  btn.setAttribute("data-variant", "ghost");
  btn.setAttribute("role", "menuitem");
  if (entry.action === "quit") btn.classList.add("pm-danger");
  if (!entry.enabled) {
    btn.disabled = true;
    btn.setAttribute("aria-disabled", "true");
  }

  const icon = document.createElement("span");
  icon.className = "pm-ico";
  icon.textContent = entry.icon;

  const label = document.createElement("span");
  label.className = "pm-label";
  label.textContent = entry.label;

  btn.append(icon, label);

  if (entry.checked !== undefined) {
    // 开关态：勾上的那一格才上色，其余保持同一块玻璃
    const box = document.createElement("span");
    box.className = "pm-box";
    if (entry.checked) {
      box.setAttribute("data-on", "");
      box.textContent = "✓";
    }
    btn.append(box);
    btn.setAttribute("aria-checked", String(entry.checked));
  } else if (entry.hint) {
    const hint = document.createElement("span");
    hint.className = "pm-hint";
    hint.textContent = entry.hint;
    btn.append(hint);
  }

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!entry.enabled) return;
    onPick(entry.action);
  });
  return btn;
}

function group(g: MenuGroup, onPick: (action: MenuAction) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pm-group";
  const title = document.createElement("p");
  title.className = "pm-grouptitle";
  title.textContent = g.title;
  wrap.append(title);
  for (const entry of g.items) wrap.append(item(entry, onPick));
  return wrap;
}

/**
 * @param avatar 狗头 dataURL（和托盘图标同一套程序化绘制，工程里没有图片素材）
 */
export function createPetMenu(
  avatar: () => string,
  onPick: (action: MenuAction | null) => void
): PetMenu {
  let root: HTMLElement | null = null;

  function build(request: MenuRequest): HTMLElement {
    const backdrop = document.createElement("div");
    backdrop.className = "pm-backdrop";

    const pane = document.createElement("div");
    pane.className = "pm-pane bg-popover rounded-lg";
    pane.setAttribute("role", "menu");

    const head = document.createElement("div");
    head.className = "pm-head";
    const mug = document.createElement("img");
    mug.className = "pm-mug";
    mug.src = avatar();
    mug.alt = "";
    const texts = document.createElement("div");
    texts.className = "pm-headtext";
    const name = document.createElement("p");
    name.className = "pm-name";
    name.textContent = request.name;
    const sub = document.createElement("p");
    sub.className = "pm-sub";
    sub.textContent = request.statusLine;
    texts.append(name, sub);
    head.append(mug, texts);
    pane.append(head);

    const rule = document.createElement("hr");
    rule.setAttribute("data-slot", "separator");
    rule.className = "pm-rule";
    pane.append(rule);

    for (const g of request.groups) pane.append(group(g, (action) => close(action)));

    // 点面板外任意处 = 取消：这一层铺满画布，只在菜单打开期间存在
    backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === backdrop) close(null);
    });
    backdrop.addEventListener("contextmenu", (event) => {
      // 菜单开着又右键：先收起，让主进程按新位置重开
      event.preventDefault();
      close(null);
    });

    // 面板得先挂进遮罩层，否则下面测量宽高时它不在文档里，永远是 0
    backdrop.append(pane);
    pane.style.left = "0px";
    pane.style.top = "0px";
    requestAnimationFrame(() => place(pane, request.x, request.y));
    return backdrop;
  }

  function place(pane: HTMLElement, x: number, y: number): void {
    const w = pane.offsetWidth || PANE_W;
    const h = pane.offsetHeight || 320;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 靠近右/下边缘时翻到另一侧，别把菜单甩出屏幕
    const left = x + w + EDGE > vw ? Math.max(EDGE, x - w - 6) : x;
    const top = y + h + EDGE > vh ? Math.max(EDGE, y - h - 6) : y;
    pane.style.left = `${Math.round(Math.max(EDGE, Math.min(left, vw - w - EDGE)))}px`;
    pane.style.top = `${Math.round(Math.max(EDGE, Math.min(top, vh - h - EDGE)))}px`;
  }

  function close(action: MenuAction | null): void {
    hide();
    onPick(action);
  }

  function show(request: MenuRequest): void {
    hide();
    root = build(request);
    document.body.append(root);
    // 下一帧再加属性，才有 transition 可播
    requestAnimationFrame(() => root?.classList.add("pm-open"));
  }

  function hide(): void {
    root?.remove();
    root = null;
  }

  return { show, hide, isOpen: () => root !== null };
}
