/** RES-13 reservation list filters and quick tabs, parsed from / written to the URL. */
import { isIsoDate } from "@/lib/calendar/dates";
import { RESERVATION_STATUSES, SOURCES, STAY_STATUSES, type ReservationStatus, type StayStatus } from "@/lib/reservations/status";

export const LIST_TABS = ["upcoming", "arriving", "departing", "in_house", "pending", "all"] as const;
export type ListTab = (typeof LIST_TABS)[number];

export const TAB_LABELS: Record<ListTab, string> = {
  upcoming: "Upcoming",
  arriving: "Arriving today",
  departing: "Departing today",
  in_house: "In house",
  pending: "Pending approval",
  all: "All",
};

export interface ReservationFilters {
  tab: ListTab;
  q: string;
  status: ReservationStatus | "";
  stay: StayStatus | "";
  listing: string;
  tag: string;
  source: string;
  checkInFrom: string;
  checkInTo: string;
  checkOutFrom: string;
  checkOutTo: string;
  createdFrom: string;
  createdTo: string;
  balanceDue: boolean;
  page: number;
}

type Params = Record<string, string | string[] | undefined>;

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim() : "");
const date = (v: string | string[] | undefined) => (isIsoDate(str(v)) ? str(v) : "");
const uuid = (v: string | string[] | undefined) => (/^[0-9a-f-]{36}$/i.test(str(v)) ? str(v) : "");

export function parseFilters(params: Params): ReservationFilters {
  const tab = str(params.tab) as ListTab;
  const status = str(params.status) as ReservationStatus;
  const stay = str(params.stay) as StayStatus;
  const source = str(params.source);
  return {
    tab: LIST_TABS.includes(tab) ? tab : "upcoming",
    q: str(params.q).slice(0, 100),
    status: RESERVATION_STATUSES.includes(status) ? status : "",
    stay: STAY_STATUSES.includes(stay) ? stay : "",
    listing: uuid(params.listing),
    tag: str(params.tag).slice(0, 50),
    source: (SOURCES as readonly string[]).includes(source) ? source : "",
    checkInFrom: date(params.ci_from),
    checkInTo: date(params.ci_to),
    checkOutFrom: date(params.co_from),
    checkOutTo: date(params.co_to),
    createdFrom: date(params.created_from),
    createdTo: date(params.created_to),
    balanceDue: str(params.balance) === "due",
    page: Math.max(1, Math.min(1000, Number(str(params.page)) || 1)),
  };
}

/** Filters as URL query (only non-empty values; page omitted unless > 1). */
export function filtersToQuery(f: Partial<ReservationFilters>): string {
  const p = new URLSearchParams();
  const set = (k: string, v: string | undefined) => {
    if (v) p.set(k, v);
  };
  if (f.tab && f.tab !== "upcoming") p.set("tab", f.tab);
  set("q", f.q);
  set("status", f.status);
  set("stay", f.stay);
  set("listing", f.listing);
  set("tag", f.tag);
  set("source", f.source);
  set("ci_from", f.checkInFrom);
  set("ci_to", f.checkInTo);
  set("co_from", f.checkOutFrom);
  set("co_to", f.checkOutTo);
  set("created_from", f.createdFrom);
  set("created_to", f.createdTo);
  if (f.balanceDue) p.set("balance", "due");
  if (f.page && f.page > 1) p.set("page", String(f.page));
  return p.toString();
}

/** What each quick tab means, given today's date (account timezone). */
export function tabConstraints(tab: ListTab, today: string): {
  statuses?: ReservationStatus[];
  stay?: StayStatus[];
  checkInEq?: string;
  checkOutEq?: string;
  checkInGte?: string;
} {
  switch (tab) {
    case "arriving":
      return { statuses: ["confirmed"], checkInEq: today };
    case "departing":
      return { statuses: ["confirmed"], checkOutEq: today };
    case "in_house":
      return { statuses: ["confirmed"], stay: ["checked_in"] };
    case "pending":
      return { statuses: ["reserved"] };
    case "upcoming":
      return { statuses: ["inquiry", "reserved", "confirmed"], checkInGte: today };
    default:
      return {};
  }
}
