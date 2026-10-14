import { dialog } from "electron";
import type { FeedReply } from "../shared/ipc";
import { feedFiles } from "./feed";
import { pushAte } from "./ipc";

/**
 * 喂食的统一入口：菜单「喂文件…」、食盆文件夹 watcher、渲染层投放，
 * 三条路最后都走这里，保证「结算 + 通知狗」只有一份实现。
 */
export async function feedPaths(paths: string[]): Promise<FeedReply> {
  const reply = await feedFiles(paths);
  if (reply.ate.length > 0) {
    // 通知狗跑去吃；成长系统已取消，这里不再带数值
    pushAte({ items: reply.ate });
  }
  return reply;
}

export async function openFeedDialog(): Promise<void> {
  // 故意不传父窗口：狗窗口是 focusable:false（WS_EX_NOACTIVATE），
  // 挂它当父亲的对话框拿不到键盘焦点，用户连个路径都输不了。
  const result = await dialog.showOpenDialog({
    title: "喂给小狗（文件会进回收站，不是永久删除）",
    buttonLabel: "喂它",
    properties: ["openFile", "multiSelections"]
  });
  if (result.canceled || result.filePaths.length === 0) return;
  await feedPaths(result.filePaths);
}
