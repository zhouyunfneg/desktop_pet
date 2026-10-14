import { Menu, app } from "electron";
import { pathToFileURL } from "node:url";
import { pushState, registerIpc, setStateProvider, bindDecoWindow, organizeNow, undoOrganizeNow } from "./ipc";
import { showPetContextMenu } from "./menu";
import { createOverlay, destroyOverlay, refreshOverlay } from "./overlay-window";
import { createPetWindow, getPetWindow, onFeedingMode } from "./pet-window";
import { RENDERER_DIR } from "./paths";
import { patchSettings, registerStateIpc, seedZones, uiState } from "./state";
import { closeSettings, openSettings } from "./settings-window";
import { refreshTrayMenu } from "./tray";

// 远程桌面 / 老显卡下透明窗可能整块发黑，留一个不用改代码就能切换软渲染的口子
if (process.env.DPET_DISABLE_GPU === "1") {
  app.disableHardwareAcceleration();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getPetWindow();
    if (win && !win.isVisible()) win.show();
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId("com.desktoppet.shiba");
    Menu.setApplicationMenu(null);

    // 宠物只加载本地页面，任何 window.open / 外链跳转一律拒绝。
    // 必须建在窗口之前：web-contents-created 对已经创建完的 contents 不会补发，
    // 早先放在 createPetWindow 之后导致狗窗的报错一条也看不到。
    const home = process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(RENDERER_DIR).href + "/";
    app.on("web-contents-created", (_event, contents) => {
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event, url) => {
        if (!url.startsWith(home)) event.preventDefault();
      });
      contents.on("render-process-gone", (_e, details) => {
        console.error(`[renderer] 进程没了 reason=${details.reason} code=${details.exitCode}`);
      });
      if (process.env.DPET_DEBUG) {
        // 透明窗没有任务栏入口，调试时把渲染层日志接回终端，不然看不到任何报错
        contents.on("console-message", (_e, level, message) => {
          console.log(`[renderer:${level}] ${message}`);
        });
        contents.on("did-fail-load", (_e, code, desc) => {
          console.error(`[renderer] 加载失败 ${code} ${desc}`);
        });
      }
    });

    const win = createPetWindow();
    registerIpc(win);
    registerStateIpc();
    setStateProvider(uiState);

    // 装饰绘制层：专画区域框（狗窗被 setShape 裁剪，画不到热区外）；绑定后 pushState 会一并推给它
    const deco = createOverlay();
    if (deco) bindDecoWindow(deco);

    // 右键走原生 context-menu：渲染层一拦 contextmenu 事件就不会触发，所以这边不拦
    win.webContents.on("context-menu", (_event, params) => {
      if (process.env.DPET_DEBUG) {
        console.log(`[main] context-menu @ ${params.x},${params.y}`);
      }
      showPetContextMenu(params.x, params.y);
    });

    onFeedingMode(() => {
      // 拖喂倒计时变化要同时让狗窗（碗高亮）和菜单/托盘看到
      pushState();
      refreshTrayMenu();
    });

    // QA 钩子：DPET_ZONES=1 播种默认区域并强制常驻显示，用来验证区域框到底画不画得出来
    if (process.env.DPET_ZONES) {
      seedZones();
      patchSettings({ showZones: true });
      console.log("[qa] 已播种默认区域并开启常驻显示");
    }
    // 按当前 showZones 决定绘制层初始可见性
    refreshOverlay();

    // QA 钩子：启动后自动跑一次整理 / 撤销，用于端到端验证图标挪位与回退
    if (process.env.DPET_ORGANIZE) setTimeout(() => void organizeNow(), 2500);
    if (process.env.DPET_UNDO) setTimeout(() => void undoOrganizeNow(), 2500);

    // 开发/QA 开关：启动就把设置窗开出来，方便直接看界面，不影响正常使用
    if (process.env.DPET_SETTINGS) openSettings();
  });
}

// 窗口只会被隐藏不会被关掉；真被关掉（比如渲染层崩溃）就退出，避免留个没窗的进程
app.on("window-all-closed", () => {
  closeSettings();
  destroyOverlay();
  app.quit();
});
