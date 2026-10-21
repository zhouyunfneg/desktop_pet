import { Menu, app } from "electron";
import { pathToFileURL } from "node:url";
import { pushAte, registerIpc, setStateProvider, bindDecoWindow, organizeNow, undoOrganizeNow } from "./ipc";
import { showPetContextMenu, registerMenuIpc } from "./menu";
import { createOverlay, destroyOverlay, refreshOverlay } from "./overlay-window";
import { createPetWindow, getPetWindow } from "./pet-window";
import { RENDERER_DIR } from "./paths";
import { patchSettings, registerStateIpc, seedZones, uiState } from "./state";
import { closeSettings, openSettings } from "./settings-window";
import { cancelCarrying, recoverCarry } from "./organize";
import { recover as recoverFold } from "./fold";

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

    // 收纳模式真动过文件，账在 fold.json 里。上次要是搬到一半就没了，
    // 先只做安全补救（把卡在文件夹里带着隐藏属性的文件显形、补账），绝不自动搬回来。
    const foldNote = await recoverFold();
    if (foldNote) console.log(`[main] 收纳账本补救：${foldNote}`);

    // 叼图标时真文件是被临时打上隐藏属性的。万一上次进程正好在这几秒里没了，
    // 桌面就少了个文件 —— 所以先把它改回来，再让狗出现。
    const rescued = await recoverCarry();
    if (rescued > 0) console.log(`[main] 找回上次没放好的图标 ${rescued} 个`);

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
    registerMenuIpc();
    setStateProvider(uiState);
    if (foldNote) {
      // 页面还没加载完就推，气泡会被丢掉，所以等一次 did-finish-load
      win.webContents.once("did-finish-load", () => {
        setTimeout(() => pushAte({ items: [], note: foldNote }), 900);
      });
    }

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

// 正常退出前把嘴里那只放回来：属性是同步改回的，图标不会因为退出而留在隐藏状态
app.on("before-quit", () => void cancelCarrying());
