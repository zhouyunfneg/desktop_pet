import { describe, expect, it } from "vitest";
import {
  attrsAfter,
  FILE_ATTRIBUTE_HIDDEN,
  FILE_ATTRIBUTE_NORMAL,
  FILE_ATTRIBUTE_READONLY,
  isHiddenAttr,
  pickDesktopFile
} from "../src/shared/file-attrs";
import { normalizeCarry } from "../src/shared/normalize";

describe("文件属性改写", () => {
  it("只动隐藏那一位，其余属性原样保留", () => {
    const ro = FILE_ATTRIBUTE_READONLY | 0x20; // 只读 + 存档
    expect(attrsAfter(ro, true)).toBe(ro | FILE_ATTRIBUTE_HIDDEN);
    expect(attrsAfter(ro | FILE_ATTRIBUTE_HIDDEN, false)).toBe(ro);
  });

  it("一位都不剩时写 NORMAL，传 0 会被 Windows 拒掉", () => {
    expect(attrsAfter(FILE_ATTRIBUTE_HIDDEN, false)).toBe(FILE_ATTRIBUTE_NORMAL);
    expect(attrsAfter(0, false)).toBe(FILE_ATTRIBUTE_NORMAL);
  });

  it("重复隐藏 / 重复取消都是幂等的", () => {
    const a = attrsAfter(0x20, true);
    expect(attrsAfter(a, true)).toBe(a);
    expect(attrsAfter(a, false)).toBe(0x20);
    expect(isHiddenAttr(a)).toBe(true);
    expect(isHiddenAttr(0x20)).toBe(false);
  });
});

describe("桌面显示名对到真实文件名", () => {
  it("显示名不带扩展名时按基名匹配", () => {
    expect(pickDesktopFile("报告", ["报告.docx", "其他.txt"])).toBe("报告.docx");
    expect(pickDesktopFile("夸克", ["夸克.lnk"])).toBe("夸克.lnk");
    expect(pickDesktopFile("照片 1", ["照片 1.PNG"])).toBe("照片 1.PNG");
  });

  it("用户开着「显示扩展名」时，看到的名字本身就是全名", () => {
    expect(pickDesktopFile("报告.docx", ["报告.docx", "报告.txt"])).toBe("报告.docx");
  });

  it("基名撞车时宁可不藏：返回 null", () => {
    expect(pickDesktopFile("新建文件夹", ["新建文件夹", "新建文件夹.txt"])).toBeNull();
  });

  it("点开头的隐藏系统文件与 desktop.ini 不参与匹配", () => {
    expect(pickDesktopFile("desktop", ["desktop.ini"])).toBeNull();
    // 「.gitignore」的显示名就是整串（开头没有可去的扩展名）
    expect(pickDesktopFile(".gitignore", [".gitignore"])).toBe(".gitignore");
  });

  it("空名字、找不到都返回 null", () => {
    expect(pickDesktopFile("   ", ["a.txt"])).toBeNull();
    expect(pickDesktopFile("没有这个", ["a.txt"])).toBeNull();
    expect(pickDesktopFile("a", [])).toBeNull();
  });
});

describe("叼运存档清洗", () => {
  const rec = {
    path: "C:\\Users\\a\\Desktop\\报告.docx",
    name: "报告",
    wasHidden: false,
    homeX: 14,
    homeY: 305,
    at: 1
  };

  it("正常记录原样留下", () => {
    expect(normalizeCarry({ version: 1, hidden: [rec] }).hidden).toEqual([rec]);
  });

  it("路径为空、坐标不是数字的记录一律丢掉", () => {
    const log = normalizeCarry({
      version: 1,
      hidden: [
        { ...rec, path: "   " },
        { ...rec, homeX: NaN },
        { ...rec, homeY: "305" },
        rec
      ]
    });
    expect(log.hidden).toEqual([rec]);
  });

  it("整份存档是垃圾时也只是一个空列表", () => {
    for (const raw of [null, undefined, 42, "x", [], { hidden: {} }, { hidden: [null, {}] }]) {
      expect(normalizeCarry(raw)).toEqual({ version: 1, hidden: [] });
    }
  });

  it("wasHidden 只认真正的 true，其余按 false（宁可多恢复一次）", () => {
    expect(normalizeCarry({ hidden: [{ ...rec, wasHidden: 1 }] }).hidden[0].wasHidden).toBe(false);
    expect(normalizeCarry({ hidden: [{ ...rec, wasHidden: true }] }).hidden[0].wasHidden).toBe(true);
  });
});
