import { describe, expect, it } from "vitest";
import {
  IDENTITY_GEOMETRY,
  dipListToPhys,
  dipToPhys,
  physListToDip,
  physToDip,
  safeGeometry
} from "../src/shared/coords";

describe("屏幕坐标换算（DIP ↔ 物理像素）", () => {
  it("100% 缩放下换算等于原值", () => {
    expect(physToDip(1500, 0, 0, 1)).toBe(1500);
    expect(dipToPhys(1500, 0, 0, 1)).toBe(1500);
  });

  it("150% 缩放下同一个位置两种单位差 scaleFactor 倍", () => {
    // 物理像素 1500 在 150% 缩放下的 DIP 位置是 1000
    expect(physToDip(1500, 0, 0, 1.5)).toBe(1000);
    expect(dipToPhys(1000, 0, 0, 1.5)).toBe(1500);
  });

  it("往返换算稳定（写回 FFI 的坐标不会因为取整累积漂移）", () => {
    for (const phys of [0, 14, 103, 777, 1838, 1919]) {
      const dip = physToDip(phys, 0, 0, 1.25);
      expect(Math.abs(dipToPhys(dip, 0, 0, 1.25) - phys)).toBeLessThanOrEqual(1);
    }
  });

  it("多屏负原点也换算正确", () => {
    // 副屏 DIP 原点 -1920、物理原点 -3840（150% 之类混合缩放下的常见排布）
    expect(physToDip(-3840, -3840, -1920, 2)).toBe(-1920);
    expect(dipToPhys(-1920, -1920, -3840, 2)).toBe(-3840);
  });

  it("批量转换只动坐标，保留 index/name 等其余字段", () => {
    const icons = [
      { index: 0, name: "报告", x: 1500, y: 300 },
      { index: 1, name: "照片", x: 750, y: 150 }
    ];
    const dip = physListToDip(icons, { dipX: 0, dipY: 0, physX: 0, physY: 0, scaleFactor: 1.5 });
    expect(dip).toEqual([
      { index: 0, name: "报告", x: 1000, y: 200 },
      { index: 1, name: "照片", x: 500, y: 100 }
    ]);
    const back = dipListToPhys(dip, { dipX: 0, dipY: 0, physX: 0, physY: 0, scaleFactor: 1.5 });
    expect(back.map((i) => `${i.x},${i.y}`)).toEqual(["1500,300", "750,150"]);
    expect(back[0].name).toBe("报告");
  });

  it("scaleFactor 异常时退化为 100%，不会算出 NaN 坐标", () => {
    for (const bad of [0, -1, Number.NaN, undefined, null]) {
      const g = safeGeometry({ dipX: 0, dipY: 0, physX: 0, physY: 0, scaleFactor: bad as number });
      expect(g.scaleFactor).toBe(1);
    }
    const g = safeGeometry(null);
    expect(g).toEqual(IDENTITY_GEOMETRY);
    const list = physListToDip([{ x: 100, y: 100 }], { dipX: 0, dipY: 0, physX: 0, physY: 0, scaleFactor: 0 });
    expect(Number.isFinite(list[0].x)).toBe(true);
  });
});

// 换算在整理链路里到底对不对，看 test/organize-scale.test.ts：
// 那里用真实的 buildPlan + 区域配置跑整条链路，而不是只算这几个函数。
