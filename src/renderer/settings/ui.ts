import type { AppConfig, CategoryRule, RoamMode, UiState, Zone } from "../../shared/ipc";

/**
 * 设置窗界面。
 * 没有引框架：整页控件不多，用「一次建骨架 + 定向刷新 + 结构变了才重建行」
 * 就能避免重渲染把输入焦点弄丢，比为了几个表单拉一整个框架划算。
 */
const api = window.pet;

type El = HTMLElement;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value as EventListener);
    } else node.setAttribute(key, String(value));
  }
  for (const kid of kids) node.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  return node;
}

function card(title: string, ...kids: El[]): El {
  return h("section", { class: "card" }, h("h2", { text: title }), ...kids);
}

export async function mountSettings(root: El): Promise<void> {
  let state: UiState | null = null;
  /** 规则与区域的可编辑副本；每次保存后由主进程回读的清洗结果覆盖 */
  let draft: AppConfig = { version: 1, rules: [], zones: [] };
  let selectedZone: string | null = null;

  root.replaceChildren();

  const head = h(
    "header",
    { class: "page-head" },
    h("h1", { text: "小柴的设置" }),
    h("p", { text: "改一项就立刻存好，不用找「保存」按钮。" })
  );
  const headTitle = head.querySelector("h1");

  // ---------- 小狗 ----------
  const nameInput = h("input", {
    type: "text",
    maxlength: "24",
    placeholder: "小柴",
    "aria-label": "狗的名字"
  }) as HTMLInputElement;
  const dogCard = card(
    "小狗",
    h("label", { class: "row inline" }, h("span", { text: "名字" }), nameInput),
    h("p", { class: "hint" }, "右键菜单和收纳确认的标题都用这个名字。最长 12 个字，多了会自动截掉。")
  );

  // ---------- 喂食 ----------
  const deskLine = h("p", { class: "muted" });
  const feeding = card(
    "喂食",
    deskLine,
    h("p", { class: "muted" }, "把要丢的文件直接拖到碗上，狗会跑过去吃掉 —— 文件进回收站，不是永久删除。"),
    h("p", { class: "hint" }, "碗一直在可点范围内，从资源管理器拖文件到碗上就能投喂，不需要任何开关；不想瞄着碗丢就用右键菜单的「喂文件…」挑。")
  );

  // ---------- 窗口 ----------
  const topmostBox = h("input", { type: "checkbox", id: "topmost" }) as HTMLInputElement;
  const windows = card(
    "窗口",
    h("label", { class: "row inline" }, topmostBox, h("span", { text: "始终置顶（关掉后狗会被其他窗口盖住）" })),
    h("p", { class: "hint" }, "贴桌面层需要原生 SetParent，留到 M4 引入 FFI 后开放。")
  );

  // ---------- 漫游 ----------
  const roamSel = h("select");
  for (const [value, text] of [
    ["chase", "追鼠标（掉头追，追到距离内待机）"],
    ["flee", "躲鼠标（靠太近就跑开）"],
    ["stay", "不跟随（自己跑去右下角蹲着）"],
    ["wander", "自己闲逛（不理鼠标）"]
  ] as const) {
    const opt = h("option", { value, text });
    roamSel.append(opt);
  }
  const dist = h("input", { type: "range", min: "150", max: "900", step: "10" }) as HTMLInputElement;
  const distVal = h("span", { class: "muted" });
  // 滑杆已填的那一段用强调色，靠一个 CSS 变量把百分比交给样式表画
  const paintFill = (): void => {
    const min = Number(dist.min);
    const max = Number(dist.max);
    const pct = ((Number(dist.value) - min) / (max - min)) * 100;
    dist.style.setProperty("--fill", `${Math.round(Math.min(100, Math.max(0, pct)))}%`);
  };
  dist.addEventListener("input", paintFill);
  const roamCard = card(
    "漫游",
    h("label", { class: "row inline" }, h("span", { text: "默认行为" }), roamSel),
    h("label", { class: "row inline" }, h("span", { text: "保持距离" }), dist, distVal),
    h("p", { class: "hint" }, "狗在整块工作区里跑，脚底贴任务栏上方；食盆钉在右下角，开饭时不管多远都会跑过去。")
  );

  // ---------- 分类规则 ----------
  const rulesBody = h("tbody");
  const addRuleBtn = h("button", { class: "ghost", text: "＋ 新增分类" });
  const rulesCard = card(
    "分类规则",
    h(
      "table",
      { class: "grid" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { text: "分类" }),
          h("th", { text: "扩展名（逗号分隔）" }),
          h("th", {})
        )
      ),
      rulesBody
    ),
    h("div", { class: "row" }, addRuleBtn),
    h("p", { class: "hint" }, "这张表决定「哪类图标搬去哪个区域」。")
  );

  // ---------- 区域 ----------
  const zonesBody = h("tbody");
  const addZoneBtn = h("button", { class: "ghost", text: "＋ 新建区域" });
  const seedBtn = h("button", { class: "ghost", text: "生成默认三个区域" });
  const zonesCard = card(
    "整理区域",
    h(
      "table",
      { class: "grid" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { text: "名称" }),
          h("th", { text: "收哪类" }),
          h("th", { class: "num", text: "启用" }),
          h("th", {})
        )
      ),
      zonesBody
    ),
    h("div", { class: "row" }, addZoneBtn, seedBtn),
    h("p", { class: "hint" }, "区域从屏幕右边开始自动排列，每区域 2 列图标宽。狗按分类把图标搬进对应区域。")
  );

  // ---------- 整理 ----------
  // 另有两种模式已封存、代码留着：「收纳进分类文件夹」（会真搬文件，入口在 ipc.askFoldNow /
  // organize.runFoldOrganize）和「只排整齐」（organize.runColumns）。要放开就往这个菜单/卡片上加回入口。
  const previewBtn = h("button", { class: "ghost", text: "预览会搬哪些" });
  const organizeBtn = h("button", { class: "primary", text: "立即整理桌面" });
  const undoBtn = h("button", { class: "ghost", text: "撤销上一次整理" });
  const showZonesBox = h("input", { type: "checkbox" }) as HTMLInputElement;
  const organizeCard = card(
    "整理桌面",
    h("label", { class: "row inline" }, showZonesBox, h("span", { text: "在桌面上常驻显示区域框" })),
    h("div", { class: "row" }, previewBtn, organizeBtn, undoBtn),
    h("p", { class: "hint" }, "按分类规则把桌面图标挪进各区域（只挪位置，文件不动，可整批撤销）。食盆与已有文件夹不会被扫。")
  );

  const status = h("div", { class: "status", text: "读取中…" });
  root.append(head, dogCard, feeding, windows, roamCard, rulesCard, zonesCard, organizeCard, status);

  // ---------- 提交流程 ----------
  function setStatus(text: string, kind = ""): void {
    status.textContent = text;
    status.className = `status ${kind}`;
  }

  function apply(next: UiState): void {
    state = next;
    draft = { version: 1, rules: next.config.rules.map((r) => ({ ...r, exts: [...r.exts] })), zones: next.config.zones.map((z) => ({ ...z, rect: { ...z.rect } })) };
    renderAll();
  }

  /** 所有写操作统一走这里：保存中 → 提交 → 用主进程回读的结果刷新 */
  async function commit(run: () => Promise<UiState>, quiet = false): Promise<void> {
    if (!quiet) setStatus("保存中…");
    try {
      const next = await run();
      apply(next);
      if (!quiet) setStatus("已保存", "ok");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "err");
    }
  }

  // ---------- 渲染 ----------
  function renderAll(): void {
    if (!state) return;
    deskLine.textContent = `真实桌面目录：${state.desktopDir}`;

    topmostBox.checked = state.settings.topmost;
    if (document.activeElement !== nameInput) nameInput.value = state.settings.petName;
    if (headTitle) headTitle.textContent = `${state.settings.petName}的设置`;
    roamSel.value = state.settings.roamMode;
    dist.value = String(state.settings.keepDistance);
    distVal.textContent = `${state.settings.keepDistance} px`;
    paintFill();
    showZonesBox.checked = state.settings.showZones;
    undoBtn.disabled = !state.canUndo;

    renderRules();
    renderZones();
  }

  let rulesSig = "";
  function renderRules(): void {
    const sig = draft.rules.map((r) => r.id).join("|");
    if (sig !== rulesSig) {
      rulesSig = sig;
      rulesBody.replaceChildren(...draft.rules.map(ruleRow));
    }
  }

  function ruleRow(rule: CategoryRule): El {
    const label = h("input", { value: rule.label, class: "label" });
    label.addEventListener("change", () => {
      rule.label = label.value;
      void commit(() => api.saveConfig(draft));
    });
    const exts = h("input", { value: rule.exts.join(", "), class: "exts" });
    exts.addEventListener("change", () => {
      void commit(async () => {
        // 扩展名的切分与去重交给主进程的清洗逻辑，两边只有一套规则
        const patched = { ...draft, rules: draft.rules.map((r) => (r.id === rule.id ? { ...r, exts: splitExts(exts.value) } : r)) };
        draft = patched;
        return api.saveConfig(patched);
      });
    });
    const swatch = h("i", { class: "swatch", style: `background:${rule.color}` });
    const del = h("button", { class: "mini", text: "×", title: "删除该分类" });
    del.addEventListener("click", () => {
      if (rule.id === "other") {
        setStatus("「其他」是兜底分类，删了会有文件无处可归", "err");
        return;
      }
      draft = { ...draft, rules: draft.rules.filter((r) => r.id !== rule.id) };
      void commit(() => api.saveConfig(draft));
    });
    return h(
      "tr",
      {},
      h("td", {}, h("div", { class: "cell" }, swatch, label)),
      h("td", {}, exts),
      h("td", {}, del)
    );
  }

  let zonesSig = "";
  function renderZones(): void {
    const sig = draft.zones.map((z) => `${z.id}:${z.name}:${z.ruleId}`).join("|");
    if (sig !== zonesSig) {
      zonesSig = sig;
      zonesBody.replaceChildren(...draft.zones.map(zoneRow));
    }
    if (draft.zones.length === 0) {
      zonesBody.replaceChildren(h("tr", {}, h("td", { colspan: "4", class: "empty", text: "还没有区域，点下面「生成默认三个区域」最快" })));
    }
  }

  function zoneRow(zone: Zone): El {
    const name = h("input", { value: zone.name });
    name.addEventListener("change", () => {
      zone.name = name.value;
      void commit(() => api.saveConfig(draft));
    });
    const ruleSel = h("select");
    for (const r of draft.rules) {
      const opt = h("option", { value: r.id, text: r.label });
      if (r.id === zone.ruleId) opt.selected = true;
      ruleSel.append(opt);
    }
    ruleSel.addEventListener("change", () => {
      zone.ruleId = ruleSel.value;
      const rule = draft.rules.find((r) => r.id === zone.ruleId);
      if (rule) zone.color = rule.color;
      void commit(() => api.saveConfig(draft));
    });
    const enabled = h("input", { type: "checkbox" }) as HTMLInputElement;
    enabled.checked = zone.enabled;
    enabled.addEventListener("change", () => {
      zone.enabled = enabled.checked;
      void commit(() => api.saveConfig(draft));
    });
    const del = h("button", { class: "mini", text: "×" });
    del.addEventListener("click", () => {
      draft = { ...draft, zones: draft.zones.filter((z) => z.id !== zone.id) };
      if (selectedZone === zone.id) selectedZone = null;
      void commit(() => api.saveConfig(draft));
    });
    const tr = h(
      "tr",
      { class: selectedZone === zone.id ? "selected" : "" },
      h("td", {}, h("div", { class: "cell" }, h("i", { class: "swatch", style: `background:${zone.color}` }), name)),
      h("td", {}, ruleSel),
      h("td", {}, enabled),
      h("td", {}, del)
    );
    tr.addEventListener("pointerdown", () => {
      selectedZone = zone.id;
      renderZones();
    });
    return tr;
  }

  // ---------- 事件 ----------
  nameInput.addEventListener("change", () => {
    // 空字符串交给主进程回默认名：菜单头部不能是空白
    void commit(() => api.patchSettings({ petName: nameInput.value }));
  });
  topmostBox.addEventListener("change", () => {
    void commit(() => api.patchSettings({ topmost: topmostBox.checked }));
  });
  roamSel.addEventListener("change", () => {
    void commit(() => api.patchSettings({ roamMode: roamSel.value as RoamMode }));
  });
  dist.addEventListener("change", () => {
    void commit(() => api.patchSettings({ keepDistance: Number(dist.value) || 220 }));
  });
  addRuleBtn.addEventListener("click", () => {
    const id = `rule-${Date.now().toString(36)}`;
    draft = {
      ...draft,
      rules: [
        ...draft.rules,
        { id, label: "新分类", exts: [], color: "#9AA0A6" }
      ]
    };
    void commit(() => api.saveConfig(draft));
  });

  addZoneBtn.addEventListener("click", () => {
    const rule = draft.rules[0];
    const wa = state?.workArea ?? { x: 0, y: 0, w: 1920, h: 1080 };
    // 区域从右往左自动排列：新区域放在最左边（已有区域左侧），紧挨着不留空档
    const ZONE_W = 2 * 76; // 2 列网格宽（152px）
    const ZONE_H = wa.h; // 全屏幕高度
    const existingRightmost = draft.zones.length > 0
      ? Math.min(...draft.zones.map((z) => z.rect.x))
      : wa.x + wa.w - 20;
    const zone: Zone = {
      id: `zone-${Date.now().toString(36)}`,
      name: "新区域",
      ruleId: rule?.id ?? "other",
      rect: { x: existingRightmost - ZONE_W, y: wa.y, w: ZONE_W, h: ZONE_H },
      dir: "新区域",
      color: rule?.color ?? "#9AA0A6",
      enabled: true
    };
    draft = { ...draft, zones: [...draft.zones, zone] };
    selectedZone = zone.id;
    void commit(() => api.saveConfig(draft));
  });
  seedBtn.addEventListener("click", () => void commit(() => api.seedZones()));

  // ---------- 整理（返回的不是 UiState，跑完再拉一份全量刷新 canUndo） ----------
  const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  previewBtn.addEventListener("click", () => {
    setStatus("统计中…");
    void api
      .previewOrganize()
      .then((r) =>
        setStatus(
          r.moved.length
            ? `将把 ${r.moved.length} 个图标搬进 ${r.zones.length} 个区域${r.skipped.length ? `；${r.skipped.length} 个会被跳过` : ""}`
            : "没有匹配到可整理的图标",
          r.moved.length ? "ok" : ""
        )
      )
      .catch((err) => setStatus(errText(err), "err"));
  });

  organizeBtn.addEventListener("click", () => {
    organizeBtn.disabled = true;
    setStatus("整理中…");
    void api
      .organize()
      .then(async (r) => {
        apply(await api.getState());
        setStatus(
          r.moved.length
            ? `已把 ${r.moved.length} 个图标搬进 ${r.zones.length} 个区域${r.skipped.length ? `；${r.skipped.length} 个跳过` : ""}`
            : "没有需要搬的图标",
          r.moved.length ? "ok" : ""
        );
      })
      .catch((err) => setStatus(errText(err), "err"))
      .finally(() => (organizeBtn.disabled = false));
  });

  undoBtn.addEventListener("click", () => {
    undoBtn.disabled = true;
    setStatus("撤销中…");
    void api
      .undoOrganize()
      .then(async (r) => {
        apply(await api.getState());
        setStatus(
          r.restored
            ? `已把 ${r.restored} 个图标放回原位${r.failed.length ? `；${r.failed.length} 个失败` : ""}`
            : "没有可撤销的整理",
          r.restored ? "ok" : ""
        );
      })
      .catch((err) => setStatus(errText(err), "err"))
      .finally(() => (undoBtn.disabled = !state?.canUndo));
  });

  try {
    apply(await api.getState());
    setStatus("已加载");
  } catch (err) {
    setStatus(`读取设置失败：${err instanceof Error ? err.message : String(err)}`, "err");
  }

  // 这扇窗没订阅 stateChanged，而菜单/托盘也能改置顶、区域开关和 canUndo，
  // 所以重新获得焦点时补拉一次全量，界面不会一直停在打开那一刻的旧快照。
  // 但光标还在输入控件里时必须跳过：apply() 会整体换掉 draft，而表格行只在
  // id 签名变化时重建，输入框的闭包还指向旧对象 —— 那时刷新会让人改了一半的内容静默丢失。
  window.addEventListener("focus", () => {
    const ae = document.activeElement;
    if (
      ae instanceof HTMLInputElement ||
      ae instanceof HTMLSelectElement ||
      ae instanceof HTMLTextAreaElement
    ) {
      return;
    }
    void commit(() => api.getState(), true);
  });
}

function splitExts(text: string): string[] {
  return text
    .split(/[,、;；\s]+/)
    .map((e) => e.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
}
