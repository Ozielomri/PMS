/** RES-13 CSV export of the reservation list. Money columns only when the user may see money. */
import { csvCell } from "@/lib/properties/export";
import { formatMoney } from "@/lib/properties/money";

export interface ExportReservation {
  code: string;
  status: string;
  stay_status: string | null;
  kind: string;
  source: string;
  channel_reservation_id: string | null;
  listing: string;
  unit: string | null;
  guest: string;
  guest_email: string | null;
  guest_phone: string | null;
  check_in: string;
  check_out: string;
  nights: number;
  adults: number;
  children: number;
  infants: number;
  pets: number;
  created_at: string;
  total_cents?: number | null;
  paid_cents?: number | null;
  balance_due_cents?: number | null;
  currency: string;
}

export function buildReservationsCsv(rows: ExportReservation[], withMoney: boolean): string {
  const headers = [
    "Code", "Status", "Stay status", "Type", "Source", "Channel code", "Listing", "Unit", "Guest", "Email", "Phone",
    "Check-in", "Check-out", "Nights", "Adults", "Children", "Infants", "Pets", "Created",
    ...(withMoney ? ["Total", "Paid", "Balance due", "Currency"] : []),
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    const cells: unknown[] = [
      r.code, r.status, r.stay_status ?? "", r.kind === "owner_stay" ? "Owner stay" : "Guest", r.source, r.channel_reservation_id ?? "",
      r.listing, r.unit ?? "", r.guest, r.guest_email ?? "", r.guest_phone ?? "",
      r.check_in, r.check_out, r.nights, r.adults, r.children, r.infants, r.pets, r.created_at.slice(0, 10),
    ];
    if (withMoney) {
      const money = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
      cells.push(money(r.total_cents), money(r.paid_cents), money(r.balance_due_cents), r.currency);
    }
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export { formatMoney };
