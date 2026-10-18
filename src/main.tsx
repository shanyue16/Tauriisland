import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDevGuards } from "./config/devOptions";
import "./index.css";

// 开发期守卫（右键菜单等），正式版内部直接 return
installDevGuards();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
