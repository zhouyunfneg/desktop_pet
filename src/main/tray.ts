import { Tray, app, nativeImage } from "electron";
import { buildTrayMenu } from "./menu";
import { toggleVisible } from "./pet-window";

let tray: Tray | null = null;

/** 托盘图标由渲染层的 canvas 现生成，所以工程里不放任何 .ico/.png 素材 */
export function ensureTray(dataUrl: string): void {
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) {
    console.warn("[tray] 收到的图标数据无效，本次不创建托盘");
    return;
  }
  if (tray) {
    tray.setImage(image);
    return;
  }
  tray = new Tray(image);
  tray.setToolTip("桌面宠物 · 柴犬");
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", () => {
    toggleVisible();
    refreshTrayMenu();
  });
}

/** 菜单项文本是快照（能不能撤销、当前跟随模式），状态变了要主动重刷一次 */
export function refreshTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

app.on("before-quit", destroyTray);
