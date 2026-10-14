// koffi 没有随包类型声明。shorthand ambient module 让所有从它导入的东西按 any 处理，
// 桌面图标 FFI 的调用形态动态且底层，这里不逐函数补类型。
declare module "koffi";
