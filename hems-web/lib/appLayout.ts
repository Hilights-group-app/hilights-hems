export type AppLayout = "compact" | "desktop";

// Screen dimensions stay useful when a small tablet rotates into landscape.
// Large tablets use desktop tools; split-view windows fall back to compact tools.
export function selectAppLayout(viewportWidth: number, screenWidth: number, screenHeight: number, touchPoints: number): AppLayout {
  const shortEdge = Math.min(screenWidth, screenHeight);
  if (touchPoints > 0 && shortEdge > 0) {
    return shortEdge >= 820 && viewportWidth >= 820 ? "desktop" : "compact";
  }
  return viewportWidth >= 1280 ? "desktop" : "compact";
}

export function getAppLayout(): AppLayout {
  if (typeof window === "undefined") return "compact";
  return selectAppLayout(window.innerWidth, window.screen.width, window.screen.height, window.navigator.maxTouchPoints || 0);
}

// Run before paint, then keep the same decision in React and CSS.
export const APP_LAYOUT_BOOTSTRAP = `try { document.documentElement.dataset.hemsLayout = (${selectAppLayout.toString()})(window.innerWidth,screen.width,screen.height,navigator.maxTouchPoints || 0); } catch {}`;
