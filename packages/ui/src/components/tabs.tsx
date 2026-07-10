"use client";

import { useState, type ReactNode } from "react";
import { cn } from "../lib/utils";

export interface TabItem {
  value: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  defaultValue?: string;
  className?: string;
}

export function Tabs({ items, defaultValue, className }: TabsProps) {
  const [active, setActive] = useState(defaultValue ?? items[0]?.value);

  return (
    <div className={className}>
      <div role="tablist" className="mb-6 flex gap-1 border-b border-border">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active === item.value}
            onClick={() => setActive(item.value)}
            className={cn(
              "-mb-px mr-5 border-b-2 px-1 py-[10px] text-[13.5px] font-bold transition-colors",
              active === item.value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <div key={item.value} role="tabpanel" hidden={active !== item.value}>
          {active === item.value && item.content}
        </div>
      ))}
    </div>
  );
}
