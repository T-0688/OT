import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./dsh-tokens.css";
import "./styles.css";

type BoundaryState = { error: Error | null };

/** 兜底：任何渲染异常都不要变成整屏白，至少给出信息和重载按钮 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("render error:", error, info);
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 28, fontFamily: "system-ui, sans-serif", color: "#111" }}>
        <h2 style={{ margin: "0 0 8px", fontSize: 18 }}>界面出错了</h2>
        <p style={{ margin: "0 0 12px", color: "#555", fontSize: 13 }}>其他功能没受影响，重新加载即可恢复。</p>
        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 12,
            color: "#7a2e2e",
            background: "#f6f6f8",
            padding: 12,
            borderRadius: 8,
            maxHeight: 220,
            overflow: "auto",
          }}
        >
          {String(error.message || error)}
        </pre>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button onClick={() => location.reload()} style={{ padding: "6px 14px", borderRadius: 8 }}>
            重新加载
          </button>
          <button onClick={() => this.setState({ error: null })} style={{ padding: "6px 14px", borderRadius: 8 }}>
            重试渲染
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
