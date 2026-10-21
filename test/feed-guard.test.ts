import { describe, expect, it } from "vitest";
import {
  MAX_BATCH,
  PROTECTED_BASENAMES,
  REASON_TOO_MANY,
  basenameOf,
  isAbsolutePath,
  rejectReason,
  splitFeedBatch,
  underProtectedRoot
} from "../src/shared/feed-guard";

const ROOTS = ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata"];

describe("投喂护栏：路径判定", () => {
  it("只认绝对路径", () => {
    expect(isAbsolutePath("C:\\a\\b.txt")).toBe(true);
    expect(isAbsolutePath("\\\\nas\\share\\a.txt")).toBe(true);
    expect(isAbsolutePath("D:/x/y")).toBe(true);
    expect(isAbsolutePath("a\\b.txt")).toBe(false);
    expect(isAbsolutePath("./secret.txt")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });

  it("basename 兼容两种分隔符与结尾斜杠", () => {
    expect(basenameOf("C:\\a\\b\\报告.docx")).toBe("报告.docx");
    expect(basenameOf("C:/a/b/photo.png")).toBe("photo.png");
    expect(basenameOf("C:\\a\\b\\")).toBe("b");
    expect(basenameOf("C:\\\\")).toBe("C:");
    expect(basenameOf("")).toBe("");
  });

  it("系统占位文件一律拒", () => {
    for (const name of PROTECTED_BASENAMES) {
      expect(rejectReason(`C:\\Users\\me\\Desktop\\${name}`, "file", ROOTS)).toContain("系统占位文件");
      expect(rejectReason(`C:\\Users\\me\\Desktop\\${name.toUpperCase()}`, "file", ROOTS)).toContain(
        "系统占位文件"
      );
    }
  });

  it("系统目录本身和里面的东西都不碰，路径写法不同也能识别", () => {
    expect(underProtectedRoot("C:\\Windows\\System32\\cmd.exe", ROOTS)).toBe(true);
    expect(underProtectedRoot("c:/windows/system32/cmd.exe", ROOTS)).toBe(true);
    expect(underProtectedRoot("C:\\Program Files\\App\\x.dll", ROOTS)).toBe(true);
    expect(underProtectedRoot("C:\\Windows", ROOTS)).toBe(true);
    expect(underProtectedRoot("C:\\Windows\\..", ROOTS)).toBe(false);
    // 名字像但不是系统目录的不能误伤
    expect(underProtectedRoot("C:\\Users\\me\\Desktop\\windows.txt", ROOTS)).toBe(false);
    expect(rejectReason("C:\\Windows\\explorer.exe", "file", ROOTS)).toContain("系统目录");
  });

  it("按真实种类给出用户看得懂的理由", () => {
    const cases: [Parameters<typeof rejectReason>[1], string][] = [
      ["empty", "路径不合法"],
      ["relative", "路径不合法"],
      ["missing", "不存在"],
      ["symlink", "符号链接"],
      ["dir", "文件夹"]
    ];
    for (const [kind, needle] of cases) {
      const reason = rejectReason("C:\\Users\\me\\Desktop\\a.txt", kind, ROOTS);
      expect(reason).not.toBeNull();
      expect(reason).toContain(needle);
    }
  });

  it("普通文件放行", () => {
    expect(rejectReason("C:\\Users\\me\\Desktop\\照片.png", "file", ROOTS)).toBeNull();
    expect(rejectReason("D:\\tmp\\a.bin", "file", [])).toBeNull();
  });

  it("相对路径即使种类是 file 也拒", () => {
    expect(rejectReason("a.txt", "file", ROOTS)).toBe("路径不合法");
    expect(rejectReason("   ", "file", ROOTS)).toBe("路径不合法");
  });
});

describe("投喂护栏：批量上限", () => {
  it("超出上限的部分要明确回报，不能静默丢弃", () => {
    const paths = Array.from({ length: MAX_BATCH + 30 }, (_, i) => `C:\\d\\f${i}.txt`);
    const { accepted, overflow } = splitFeedBatch(paths);
    expect(accepted).toHaveLength(MAX_BATCH);
    expect(overflow).toBe(30);
    expect(REASON_TOO_MANY).toContain(String(MAX_BATCH));
  });

  it("没超限时不报错", () => {
    const { accepted, overflow } = splitFeedBatch(["C:\\d\\a.txt", "C:\\d\\b.txt"]);
    expect(accepted).toHaveLength(2);
    expect(overflow).toBe(0);
  });

  it("空输入与非数组都安全", () => {
    expect(splitFeedBatch([])).toEqual({ accepted: [], overflow: 0 });
    expect(splitFeedBatch(undefined as unknown as string[])).toEqual({ accepted: [], overflow: 0 });
    expect(splitFeedBatch(["C:\\a.txt"], 0).accepted).toHaveLength(0);
    expect(splitFeedBatch(["C:\\a.txt"], -5).accepted).toHaveLength(0);
  });

  it("上限切分保持顺序，取的是前 N 个", () => {
    const paths = ["C:\\a.txt", "C:\\b.txt", "C:\\c.txt"];
    expect(splitFeedBatch(paths, 2).accepted).toEqual(["C:\\a.txt", "C:\\b.txt"]);
  });
});
