import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    // 把 ACP SDK 打进产物：它带着 zod 之类的传递依赖，外部化会在 asar 里找不到
    plugins: [externalizeDepsPlugin({ exclude: ["@agentclientprotocol/sdk", "ws"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
});

