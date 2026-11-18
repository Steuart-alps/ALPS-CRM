import { query } from "./db.ts";

export type Assessor = { id: number; name: string; email: string | null; user_id: number | null; home_postcode: string | null; home_lat: number | null; home_lng: number | null; active: boolean };
export type Group = { id: number; name: string };
export type PriceItem = { id: number; name: string; monthly_pence: number | null; annual_pence: number | null; active: boolean; sort_order: number };
export type UserLite = { id: number; name: string; email: string; role: "owner" | "staff"; active: boolean; office: boolean };

export const assessors = () => query<Assessor>("select * from assessors order by active desc, name");
export const groups = () => query<Group>("select id, name from client_groups order by name");
export const priceItems = () => query<PriceItem>("select * from price_items order by active desc, sort_order, name");
export const activeUsers = () => query<UserLite>("select id, name, email, role, active, office from users where active order by name");
export const businessTypes = async () =>
  (await query<{ t: string }>("select distinct business_type as t from clients where business_type is not null order by 1")).map((r) => r.t);

/** Who new tasks go to by default: the office person, else the first staff member. */
export function officeUser(users: UserLite[]): UserLite | undefined {
  return users.find((u) => u.office) ?? users.find((u) => u.role === "staff");
}

export const PUBLIC_TERMS = ["Guest", "Customer", "Resident", "Visitor", "Member", "Client"];

export const STATUS_LABEL: Record<string, string> = { prospect: "Prospect", client: "Client", former: "Former client" };

export const ACTIVITY_LABEL: Record<string, string> = { note: "Note", call: "Call", email: "Email", visit: "Visit", meeting: "Meeting" };

export const VISIT_STATUS_LABEL: Record<string, string> = { to_book: "To book", booked: "Booked", done: "Done", cancelled: "Cancelled" };
