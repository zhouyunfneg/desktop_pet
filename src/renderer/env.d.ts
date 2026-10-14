import type { PetBridge } from "../shared/ipc";

declare global {
  interface Window {
    /** preload 通过 contextBridge 注入的唯一越界入口 */
    pet: PetBridge;
  }
}

export {};
