import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/App";
import { ThemeProvider } from "@/components/theme-provider";

import "@/index.css";

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </StrictMode>,
  );
}
