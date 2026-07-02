"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "../lib/utils";
import type { StatusTone } from "../lib/status";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: StatusTone;
  /** Milliseconds before auto-dismiss. Defaults to 6000, pass 0 to disable. */
  durationMs?: number;
}

export interface Toast extends ToastInput {
  id: string;
}

interface ToastContextValue {
  toasts: Toast[];
  pushToast: (toast: ToastInput) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 6000;

const TONE_CLASSNAME: Record<StatusTone, string> = {
  neutral: "border-border bg-card text-card-foreground",
  info: "border-primary/30 bg-card text-card-foreground",
  success: "border-success/40 bg-card text-card-foreground",
  warning: "border-warning/40 bg-card text-card-foreground",
  destructive: "border-destructive/40 bg-card text-card-foreground",
};

const TONE_ACCENT_CLASSNAME: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  info: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (input: ToastInput) => {
      const id = crypto.randomUUID();
      const toast: Toast = { tone: "neutral", durationMs: DEFAULT_DURATION_MS, ...input, id };
      setToasts((prev) => [...prev, toast]);
      if (toast.durationMs && toast.durationMs > 0) {
        setTimeout(() => dismissToast(id), toast.durationMs);
      }
      return id;
    },
    [dismissToast],
  );

  const value = useMemo(() => ({ toasts, pushToast, dismissToast }), [toasts, pushToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[340px] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={cn(
            "pointer-events-auto relative overflow-hidden rounded-md border pl-3 pr-8 py-2.5 shadow-md",
            TONE_CLASSNAME[toast.tone ?? "neutral"],
          )}
        >
          <span className={cn("absolute left-0 top-0 h-full w-1", TONE_ACCENT_CLASSNAME[toast.tone ?? "neutral"])} />
          <div className="text-sm font-semibold">{toast.title}</div>
          {toast.description && <div className="mt-0.5 text-xs text-muted-foreground">{toast.description}</div>}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => onDismiss(toast.id)}
            className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
