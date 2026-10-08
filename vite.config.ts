import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Windows 上 Rust 编译的 DLL 会被 cargo 锁定，Vite 尝试 watch 会触发 EBUSY
      // 忽略 src-tauri 构建产物和 node_modules
      ignored: [
        "**/src-tauri/target/**",
        "**/node_modules/**",
        "**/dist/**",
      ],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "es2021",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
