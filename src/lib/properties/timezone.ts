/**
 * PRP-02: the listing timezone is derived from the address and stays editable. Without a
 * geocoding provider (none in this phase) it is derived from the US state; for states split
 * across zones we take the zone most of the state uses — the user can change it.
 */

const STATE_TIMEZONES: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/Chicago", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver", PR: "America/Puerto_Rico",
  VI: "America/St_Thomas", GU: "Pacific/Guam",
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "puerto rico": "PR",
};

/** Two-letter state code for "fl", "FL" or "Florida"; null if unknown. */
export function normalizeUsState(input: string | null | undefined): string | null {
  const v = (input ?? "").trim();
  if (!v) return null;
  const upper = v.toUpperCase();
  if (STATE_TIMEZONES[upper]) return upper;
  return STATE_NAMES[v.toLowerCase()] ?? null;
}

/** Suggested IANA timezone for an address, or null when it cannot be told. */
export function suggestTimezone(address: { countryCode?: string | null; stateRegion?: string | null }): string | null {
  const country = (address.countryCode || "US").toUpperCase();
  if (country === "PR") return "America/Puerto_Rico";
  if (country !== "US") return null;
  const state = normalizeUsState(address.stateRegion);
  return state ? STATE_TIMEZONES[state] : null;
}
