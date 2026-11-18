// Postcode lookups and visit-route ordering.
//
// Only postcodes leave the CRM: they are looked up with postcodes.io, a free
// UK service built on Ordnance Survey and ONS open data. No names or contacts
// are sent.

export type Point = { lat: number; lng: number };

export function normalisePostcode(pc: string | null | undefined): string | null {
  if (!pc) return null;
  const s = pc.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 5 || s.length > 7) return null;
  return `${s.slice(0, -3)} ${s.slice(-3)}`;
}

/** Postcode area letters, e.g. "IV2 6DH" -> "IV". */
export function postcodeArea(pc: string | null | undefined): string {
  const m = /^[A-Z]{1,2}/.exec((pc ?? "").toUpperCase().trim());
  return m ? m[0] : "?";
}

type Lookup = (postcodes: string[]) => Promise<Map<string, Point>>;

async function postcodesIo(postcodes: string[]): Promise<Map<string, Point>> {
  const out = new Map<string, Point>();
  for (let i = 0; i < postcodes.length; i += 100) {
    const batch = postcodes.slice(i, i + 100);
    const res = await fetch("https://api.postcodes.io/postcodes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postcodes: batch }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`postcode lookup failed (${res.status})`);
    const body = (await res.json()) as {
      result: { query: string; result: { latitude: number; longitude: number } | null }[];
    };
    for (const r of body.result) {
      if (r.result) out.set(normalisePostcode(r.query)!, { lat: r.result.latitude, lng: r.result.longitude });
    }
  }
  return out;
}

let lookup: Lookup = postcodesIo;

/** Tests swap the network lookup for a fixed table. */
export function setPostcodeLookup(fn: Lookup): void {
  lookup = fn;
}

export async function lookupPostcodes(postcodes: string[]): Promise<Map<string, Point>> {
  const clean = [...new Set(postcodes.map(normalisePostcode).filter((p): p is string => !!p))];
  if (clean.length === 0) return new Map();
  return lookup(clean);
}

/** Straight-line distance in miles. */
export function miles(a: Point, b: Point): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Orders stops into a short round: nearest-neighbour from the start, then
 * 2-opt to undo crossings. Stops without a location go at the end in their
 * original order.
 */
export function orderStops<T extends { point: Point | null }>(start: Point | null, stops: T[]): T[] {
  const located = stops.filter((s) => s.point);
  const unlocated = stops.filter((s) => !s.point);
  if (located.length <= 1) return [...located, ...unlocated];

  const remaining = [...located];
  const route: T[] = [];
  let here: Point = start ?? remaining[0].point!;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    remaining.forEach((s, i) => {
      const d = miles(here, s.point!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const [next] = remaining.splice(best, 1);
    route.push(next);
    here = next.point!;
  }

  const pts = (r: T[]) => (start ? [start, ...r.map((s) => s.point!)] : r.map((s) => s.point!));
  const length = (r: T[]) => {
    const p = pts(r);
    let total = 0;
    for (let i = 1; i < p.length; i++) total += miles(p[i - 1], p[i]);
    return total;
  };
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const candidate = [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
        if (length(candidate) + 0.01 < length(route)) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return [...route, ...unlocated];
}

/**
 * Splits an ordered round into trips: a new trip starts whenever the next
 * stop is more than `gapMiles` from the last one.
 */
export function splitTrips<T extends { point: Point | null }>(ordered: T[], gapMiles = 30): T[][] {
  const trips: T[][] = [];
  let current: T[] = [];
  for (const stop of ordered) {
    const last = current[current.length - 1];
    if (current.length && (!stop.point || !last.point || miles(last.point, stop.point) > gapMiles)) {
      trips.push(current);
      current = [];
    }
    current.push(stop);
  }
  if (current.length) trips.push(current);
  return trips;
}

// Drive-time heads-up. Straight-line miles are turned into a rough road
// estimate (roads are about a third longer, at about 40 mph on average).
// The map links open Google or Apple Maps for real times and traffic; they
// are free and only the postcodes go in the link.
const ROAD_FACTOR = 1.3;
const AVERAGE_MPH = 40;

export function roughDriveText(straightMiles: number): string {
  const mins = Math.round(((straightMiles * ROAD_FACTOR) / AVERAGE_MPH) * 60 / 5) * 5;
  if (mins < 5) return "under 5 minutes";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} hr${m ? ` ${m} min` : ""}` : `${m} min`;
}

const place = (pc: string) => `${pc}, UK`;

/** Google Maps directions through the postcodes in order (up to 9 stops between start and end). */
export function googleRouteUrl(postcodes: string[]): string | null {
  const pcs = postcodes.filter(Boolean);
  if (pcs.length < 2) return null;
  const middle = pcs.slice(1, -1).slice(0, 9);
  const q = new URLSearchParams({ api: "1", origin: place(pcs[0]), destination: place(pcs[pcs.length - 1]), travelmode: "driving" });
  if (middle.length) q.set("waypoints", middle.map(place).join("|"));
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/** Apple Maps driving directions from one postcode to another. */
export function appleRouteUrl(from: string, to: string): string {
  return `https://maps.apple.com/?${new URLSearchParams({ saddr: place(from), daddr: place(to), dirflg: "d" }).toString()}`;
}
