"use client";

import { useState, useTransition } from "react";

import { Alert, Button } from "@/components/ui";

import { acceptQuote } from "./actions";

export function AcceptOption({ token, optionId, label }: { token: string; optionId: string; label: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ code?: string; error?: string } | null>(null);
  if (result?.code) return <Alert tone="success">Booked! Your confirmation code is {result.code}.</Alert>;
  return (
    <div className="space-y-2">
      <Button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Book ${label}?`)) return;
          start(async () => setResult(await acceptQuote(token, optionId)));
        }}
      >
        {pending ? "Booking…" : "Book this option"}
      </Button>
      {result?.error ? <Alert tone="error">{result.error}</Alert> : null}
    </div>
  );
}
