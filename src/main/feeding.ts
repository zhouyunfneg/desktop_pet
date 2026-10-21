import { dialog } from "electron";
import { MAX_BATCH } from "../shared/feed-guard";
import type { FeedReply } from "../shared/ipc";
import { feedFiles } from "./feed";
import { pushAte } from "./ipc";

/**
 * 喂食的统一入口：菜单「喂文件…」、渲染层拖放（走 IPC 时由渲染层自己播报），
 * 都收在这里，保证「结算 + 通知狗」只有一份实现。
 */
export async function feedPaths(paths: string[]): Promise<FeedReply> {
  const reply = await feedFiles(paths);
  // 被单次上限截掉、或者一个都没吃下时都要交代一句，
  // 否则从菜单投喂的用户完全不知道文件为什么还在原地
  const note =
    reply.overflow > 0
      ? `剩下 ${reply.overflow} 个没吃，一次最多 ${MAX_BATCH} 个`
      : reply.ate.length === 0 && reply.rejected.length > 0
        ? `咬不动：${reply.rejected[0].reason}`
        : undefined;
  if (reply.ate.length > 0 || note) pushAte({ items: reply.ate, note });
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
