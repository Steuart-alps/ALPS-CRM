// Tiny HTML templating: every interpolated value is escaped unless it is
// already a SafeHtml (from html`` or raw()).

export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return esc(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function money(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return "";
  const pounds = pence / 100;
  return "£" + pounds.toLocaleString("en-GB", { minimumFractionDigits: pence % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

/** "12.50" or "£1,200" -> pence; blank -> null. */
export function parseMoney(input: unknown): number | null {
  const s = String(input ?? "").replace(/[£,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function moneyInput(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return "";
  return (pence / 100).toFixed(pence % 100 ? 2 : 0);
}

/** "2026-11-18" -> "18 Nov 2026" */
export function ukDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value.length === 10 ? value + "T12:00:00Z" : value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

/** Today's date in the UK as YYYY-MM-DD. */
export function todayUk(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

export function opt(value: string | number, label: string, selected: unknown): SafeHtml {
  const isSel = selected !== undefined && selected !== null && String(selected) === String(value);
  return html`<option value="${value}"${isSel ? raw(" selected") : ""}>${label}</option>`;
}

export function checked(on: unknown): SafeHtml {
  return on ? raw(" checked") : raw("");
}

export type NavUser = { id: number; name: string; role: "owner" | "staff" };

export function layout(opts: {
  title: string;
  user?: NavUser | null;
  body: SafeHtml;
  flash?: string | null;
  active?: string;
}): string {
  const { title, user, body, flash, active } = opts;
  const link = (href: string, label: string, key: string) =>
    html`<a href="${href}"${active === key ? raw(' aria-current="page"') : ""}>${label}</a>`;
  return html`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title} · ALPS CRM</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body>
${user
  ? html`<header class="top">
  <a class="brand" href="/">ALPS CRM</a>
  <nav>
    ${link("/", "Today", "home")}
    ${link("/clients", "Clients", "clients")}
    ${link("/visits", "Visits", "visits")}
    ${link("/tasks", "Tasks", "tasks")}
    ${link("/documents", "Documents", "documents")}
    ${link("/chasers", "Chasers", "chasers")}
    ${link("/quotes", "Quotes", "quotes")}
    ${link("/populate", "Populate", "populate")}
    ${link("/groups", "Groups", "groups")}
    ${user.role === "owner" ? link("/income", "Income", "income") : ""}
    ${user.role === "owner" ? link("/settings", "Settings", "settings") : ""}
  </nav>
  <form method="post" action="/logout" class="who"><a href="/me" title="My details">${user.name}</a><button class="link">Sign out</button></form>
</header>`
  : ""}
<main>
${flash ? html`<p class="flash" role="status">${flash}</p>` : ""}
${body}
</main>
</body>
</html>`.value;
}
