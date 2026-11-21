"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Alert, Button, Field, Input, Skeleton } from "@/components/ui";
import { normaliseTotpCode } from "@/lib/auth/mfa";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/client";

type Step =
  | { kind: "loading" }
  | { kind: "enroll"; factorId: string; qrCode: string; secret: string }
  | { kind: "verify"; factorId: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

/** Finds a verified TOTP factor, or starts a fresh enrolment. */
async function loadFactors(): Promise<Step> {
  const supabase = createClient();
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) return { kind: "error", message: "Could not load your authenticator settings." };
  const verified = data.totp.find((f) => f.status === "verified");
  if (verified) return { kind: "verify", factorId: verified.id };

  // Remove half-finished enrolments so a fresh QR code can be issued.
  for (const f of data.all.filter((f) => f.factor_type === "totp" && f.status === "unverified")) {
    await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}`,
  });
  if (enrollError || !enrolled) return { kind: "error", message: "Could not start authenticator setup. Reload to try again." };
  return { kind: "enroll", factorId: enrolled.id, qrCode: enrolled.totp.qr_code, secret: enrolled.totp.secret };
}

/**
 * X-02 TOTP. Enrols an authenticator app on first use, otherwise asks for the current code.
 * A successful verify upgrades the session to aal2, which admins need for any permission.
 */
export function MfaClient({ required, alreadyVerified }: { required: boolean; alreadyVerified: boolean }) {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get("next"));
  const [step, setStep] = useState<Step>(alreadyVerified ? { kind: "done" } : { kind: "loading" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (alreadyVerified) return;
    let cancelled = false;
    void loadFactors().then((next) => {
      if (!cancelled) setStep(next);
    });
    return () => {
      cancelled = true;
    };
  }, [alreadyVerified]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== "enroll" && step.kind !== "verify") return;
    const normalised = normaliseTotpCode(code);
    if (!normalised) {
      setError("Enter the 6-digit code from your authenticator app.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: verifyError } = await createClient().auth.mfa.challengeAndVerify({ factorId: step.factorId, code: normalised });
    setBusy(false);
    if (verifyError) {
      setError("That code did not work. Check the time on your phone and try again.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  if (step.kind === "loading") return <Skeleton lines={4} />;
  if (step.kind === "error") return <Alert tone="error">{step.message}</Alert>;
  if (step.kind === "done") {
    return (
      <div className="space-y-4">
        <Alert tone="success">This session is verified.</Alert>
        <Button className="w-full" onClick={() => router.replace(next)}>
          Continue
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {step.kind === "enroll" ? (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {required ? "Admins must use two-factor authentication. " : null}
            Scan this code with an authenticator app (1Password, Google Authenticator, Authy), then enter the 6-digit code.
          </p>
          {/* Supabase returns the QR code as an SVG data URL. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={step.qrCode} alt="QR code for your authenticator app" className="mx-auto h-44 w-44 rounded bg-white p-2" />
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">Can’t scan? Enter this key instead</summary>
            <code className="mt-2 block break-all rounded bg-slate-100 p-2 dark:bg-slate-800">{step.secret}</code>
          </details>
        </>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-300">Enter the 6-digit code from your authenticator app.</p>
      )}
      <Field label="Code" htmlFor="code">
        <Input
          id="code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          required
        />
      </Field>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Verifying…" : step.kind === "enroll" ? "Turn on two-factor" : "Verify"}
      </Button>
    </form>
  );
}
