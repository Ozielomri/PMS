"use client";

import { useState } from "react";

import { Button, Input } from "@/components/ui";

/** Read-only URL with a copy button (CAL-09 export URL). */
export function CopyField({ id, label, value }: { id: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input id={id} readOnly value={value} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
