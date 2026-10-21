import type { FoldPreviewResult } from "../../shared/ipc";

/**
 * 收纳确认面板：真搬文件之前必须先让用户点头。
 *
 * 为什么要单独一个面板而不是「点了就直接搬」：这个模式改的是文件系统，
 * 不是图标位置。搬错了虽然能撤销，但「桌面少了三个文件」这种画面足以让人心慌，
 * 所以先把清单摊开：哪个文件进哪个文件夹、哪些一律不动，看完再决定。
 *
 * 和右键菜单同一块玻璃：狗窗是透明窗，面板背后垫主题自带的光晕才糊得出材质。
 */

/** 一组最多列几个文件名，剩下的折成「+N」，免得清单把面板撑到屏幕外 */
const MAX_LISTED = 4;

export interface FoldPanel {
  show(preview: FoldPreviewResult, onOk: () => void, onCancel: () => void): void;
  hide(): void;
  isOpen(): boolean;
}

export function createFoldPanel(
  avatar: () => string,
  near: () => { x: number; y: number },
  titleOf: () => string
): FoldPanel {
  let root: HTMLElement | null = null;

  function hide(): void {
    root?.remove();
    root = null;
  }

  function build(preview: FoldPreviewResult, onOk: () => void, onCancel: () => void): HTMLElement {
    const backdrop = document.createElement("div");
    backdrop.className = "pm-backdrop";

    const pane = document.createElement("div");
    pane.className = "pm-pane pf-pane bg-popover rounded-lg";
    pane.setAttribute("role", "dialog");
    pane.setAttribute("aria-label", "收纳确认");

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
    name.textContent = titleOf();
    const sub = document.createElement("p");
    sub.className = "pm-sub";
    sub.textContent = `要把 ${preview.total} 个文件收进桌面的分类文件夹`;
    texts.append(name, sub);
    head.append(mug, texts);
    pane.append(head);

    const rule = document.createElement("hr");
    rule.setAttribute("data-slot", "separator");
    rule.className = "pm-rule";
    pane.append(rule);

    for (const g of preview.groups) {
      const row = document.createElement("div");
      row.className = "pf-group";
      const title = document.createElement("div");
      title.className = "pf-title";
      const dot = document.createElement("i");
      dot.style.background = g.color;
      const label = document.createElement("span");
      label.textContent = `🗂 ${g.folder}`;
      title.append(dot, label);
      if (g.willCreate) {
        const tag = document.createElement("em");
        tag.className = "pf-tag";
        tag.textContent = "新建";
        title.append(tag);
      }
      const n = document.createElement("span");
      n.className = "pf-count";
      n.textContent = `${g.files.length} 个`;
      title.append(n);
      row.append(title);

      const shown = g.files.slice(0, MAX_LISTED);
      for (const f of shown) {
        const li = document.createElement("p");
        li.className = "pf-file";
        li.textContent = f;
        row.append(li);
      }
      if (g.files.length > shown.length) {
        const more = document.createElement("p");
        more.className = "pf-file pf-more";
        more.textContent = `…还有 ${g.files.length - shown.length} 个`;
        row.append(more);
      }
      pane.append(row);
    }

    const foot = document.createElement("p");
    foot.className = "pf-foot";
    const still = preview.skipped.length;
    foot.textContent =
      still > 0
        ? `快捷方式、文件夹等 ${still} 项一律不动。随时能在菜单里撤销。`
        : "快捷方式、文件夹一律不动。随时能在菜单里撤销。";
    pane.append(foot);

    const btns = document.createElement("div");
    btns.className = "pf-btns";
    const ok = document.createElement("button");
    ok.className = "pf-ok bg-primary glass-primary";
    ok.setAttribute("data-slot", "button");
    ok.textContent = "开始整理";
    ok.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      onOk();
    });
    const no = document.createElement("button");
    no.className = "pf-no";
    no.setAttribute("data-slot", "button");
    no.setAttribute("data-variant", "ghost");
    no.textContent = "先不用";
    no.addEventListener("click", (e) => {
      e.stopPropagation();
      close();
      onCancel();
    });
    btns.append(ok, no);
    pane.append(btns);

    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      close();
    });

    backdrop.append(pane);
    pane.style.left = "0px";
    pane.style.top = "0px";
    requestAnimationFrame(() => place(pane));
    return backdrop;
  }

  /** 贴着狗站：面板比菜单高，靠下沿时往上翻，别甩出屏幕 */
  function place(pane: HTMLElement): void {
    const { x, y } = near();
    const w = pane.offsetWidth || 252;
    const h = pane.offsetHeight || 300;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(x - w / 2, vw - w - 8));
    const top = y - h - 96 > 8 ? y - h - 96 : Math.max(8, Math.min(y + 40, vh - h - 8));
    pane.style.left = `${Math.round(left)}px`;
    pane.style.top = `${Math.round(top)}px`;
  }

  function close(): void {
    hide();
  }

  return {
    show(preview, onOk, onCancel) {
      hide();
      root = build(preview, onOk, onCancel);
      document.body.append(root);
      requestAnimationFrame(() => root?.classList.add("pm-open"));
    },
    hide() {
      root?.remove();
      root = null;
    },
    isOpen: () => root !== null
  };
}
