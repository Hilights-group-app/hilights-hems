"use client";

import { useSyncExternalStore } from "react";
import { getAppLayout, type AppLayout } from "@/lib/appLayout";

function subscribe(callback: () => void) {
  const sync = () => {
    const next = getAppLayout();
    if (document.documentElement.dataset.hemsLayout !== next) {
      document.documentElement.dataset.hemsLayout = next;
    }
    callback();
  };
  sync();
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  return () => {
    window.removeEventListener("resize", sync);
    window.removeEventListener("orientationchange", sync);
  };
}

function serverSnapshot(): AppLayout { return "compact"; }

export function useAppLayout() {
  return useSyncExternalStore(subscribe, getAppLayout, serverSnapshot);
}
