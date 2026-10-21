import { describe, expect, it } from "vitest";
import { MENU_ACTIONS, buildMenu, isMenuAction, statusLineOf, type MenuInput } from "../src/shared/menu";

const base: MenuInput = {
  roamMode: "chase",
  keepDistance: 380,
  topmost: true,
  dogVisible: true,
  debugMenu: false,
  petName: "小柴",
  uptimeSeconds: 42
};

const flat = (input: MenuInput) => buildMenu(input).flatMap((g) => g.items);

describe("buildMenu 结构", () => {
  it("只有常用的三组，每组都有项，动作全局不重复", () => {
    const groups = buildMenu(base);
    expect(groups.map((g) => g.title)).toEqual(["陪玩", "干活", "窗口"]);
    for (const g of groups) expect(g.items.length).toBeGreaterThan(0);
    const actions = flat(base).map((e) => e.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("每个动作都在白名单里，且每项都有图标（渲染层按图标列排版）", () => {
    for (const entry of flat(base)) {
      expect(isMenuAction(entry.action)).toBe(true);
      expect(entry.icon.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.enabled).toBe("boolean");
    }
  });

  it("白名单与实际用到的动作一致，加了动作忘了注册会被这里抓到", () => {
    const used = new Set(flat({ ...base, debugMenu: true }).map((e) => e.action));
    expect([...MENU_ACTIONS].sort()).toEqual([...used].sort());
  });

  it("干活这一组只有「整理桌面」和「喂文件…」", () => {
    const work = buildMenu(base).find((g) => g.title === "干活")!;
    expect(work.items.map((e) => e.action)).toEqual(["organize", "feed"]);
    expect(work.items[0].hint).toContain("分类");
  });

  it("低频项已经不在菜单里：撤销整理、显示区域框、整块画布可点", () => {
    const actions = flat({ ...base, debugMenu: true }).map((e) => e.action);
    for (const gone of ["undo", "showZones", "canvasClick"]) {
      expect(actions).not.toContain(gone);
      expect(isMenuAction(gone)).toBe(false);
    }
    // 这两项的功能没被删，只是改从设置窗进（整理桌面卡片里有按钮和开关）
    expect(actions).toContain("settings");
  });

  it("菜单里没有禁用项：不常用的直接不给，而不是灰着摆在里面", () => {
    for (const entry of flat({ ...base, debugMenu: true })) {
      expect(entry.enabled).toBe(true);
    }
  });
});

describe("buildMenu 状态映射", () => {
  it("漫游模式决定「跟随鼠标」的勾选态", () => {
    expect(flat({ ...base, roamMode: "chase" }).find((e) => e.action === "follow")?.checked).toBe(true);
    expect(flat({ ...base, roamMode: "stay" }).find((e) => e.action === "follow")?.checked).toBe(false);
    expect(flat({ ...base, roamMode: "wander" }).find((e) => e.action === "follow")?.checked).toBe(true);
  });

  it("隐藏/显示小狗按当前可见状态给文案和图标", () => {
    const visible = flat({ ...base, dogVisible: true }).find((e) => e.action === "toggleVisible")!;
    const hidden = flat({ ...base, dogVisible: false }).find((e) => e.action === "toggleVisible")!;
    expect(visible.label).toBe("隐藏小狗");
    expect(hidden.label).toBe("显示小狗");
    expect(visible.icon).not.toBe(hidden.icon);
  });

  it("调试项只有开发启动时才出现，普通用时整个窗口组都是日常项", () => {
    expect(flat(base).some((e) => e.action === "devtools")).toBe(false);
    expect(flat({ ...base, debugMenu: true }).some((e) => e.action === "devtools")).toBe(true);
    expect(buildMenu(base).find((g) => g.title === "窗口")!.items.map((e) => e.action)).toEqual([
      "topmost",
      "toggleVisible",
      "settings",
      "quit"
    ]);
  });

  it("置顶开关如实反映存档", () => {
    expect(flat({ ...base, topmost: false }).find((e) => e.action === "topmost")?.checked).toBe(false);
    expect(flat(base).find((e) => e.action === "topmost")?.checked).toBe(true);
  });
});

describe("statusLineOf 头部副标题：陪主人一共几小时", () => {
  const line = (uptimeSeconds: number): string => statusLineOf({ ...base, uptimeSeconds });

  it("按本次启动的实际时长数满几小时，不满一小时也说 1 小时", () => {
    expect(line(0)).toBe("陪主人一共 1 小时");
    expect(line(42)).toBe("陪主人一共 1 小时");
    expect(line(3599)).toBe("陪主人一共 1 小时");
    expect(line(3600)).toBe("陪主人一共 1 小时");
    expect(line(3601)).toBe("陪主人一共 1 小时");
    expect(line(7199)).toBe("陪主人一共 1 小时");
    expect(line(7200)).toBe("陪主人一共 2 小时");
    expect(line(37_200)).toBe("陪主人一共 10 小时");
  });

  it("时长是负数或不是数字（进程数据异常）只退回 1 小时，不会写出 NaN", () => {
    expect(line(-100)).toBe("陪主人一共 1 小时");
    expect(line(Number.NaN)).toBe("陪主人一共 1 小时");
    expect(line(Number.POSITIVE_INFINITY)).toBe("陪主人一共 1 小时");
  });

  it("这一行不再报漫游模式和保持距离（那两样在勾选框与设置窗里都看得到）", () => {
    expect(line(60)).not.toContain("px");
    expect(line(60)).not.toContain("鼠标");
  });
});

describe("菜单动作白名单", () => {

  it("未知动作一律判为非法，渲染层回传不能注入", () => {
    expect(isMenuAction("quit")).toBe(true);
    for (const bad of ["", "setInterval", "RECALL", null, undefined, 3, {}, ["quit"]]) {
      expect(isMenuAction(bad)).toBe(false);
    }
  });
});
