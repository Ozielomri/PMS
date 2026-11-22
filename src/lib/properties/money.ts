/** Money is integer cents in the listing currency (USD in this phase). */

/** "150", "150.5", "1,250.00", "$99.99" → cents; null for empty; throws on anything else. */
export function parseDollarsToCents(input: string | null | undefined): number | null {
  const raw = (input ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (raw === "") return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) throw new Error("Enter an amount like 150 or 150.50");
  const [whole, frac = ""] = raw.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function centsToDollarInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

export function formatMoney(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** Percent input ("10", "12.5", "10%") → basis points (1000 = 10 %). */
export function parsePercentToBps(input: string | null | undefined): number {
  const raw = (input ?? "").trim().replace(/%$/, "");
  if (raw === "") return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) throw new Error("Enter a percentage like 10 or 12.5");
  const bps = Math.round(Number(raw) * 100);
  if (bps > 10000) throw new Error("A discount cannot exceed 100 %");
  return bps;
}

export function bpsToPercentInput(bps: number | null | undefined): string {
  if (!bps) return "";
  return String(bps / 100);
}
