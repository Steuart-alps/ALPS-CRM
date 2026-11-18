import type { Request, Response } from "express";
import { layout, type SafeHtml } from "./html.ts";
import { takeFlash } from "./auth.ts";

export function s(v: unknown): string | null {
  const t = String(v ?? "").trim();
  return t ? t : null;
}

export function int(v: unknown): number | null {
  const t = String(v ?? "").trim();
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t);
}

export function dateOrNull(v: unknown): string | null {
  const t = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)) ? t : null;
}

/** Form values that may be one string or several. */
export function list(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => String(x).trim()).filter(Boolean);
}

export function idParam(req: Request, name = "id"): number {
  const n = int(req.params[name]);
  if (n === null || n <= 0) throw new NotFound();
  return n;
}

export class NotFound extends Error {}

export function page(req: Request, res: Response, title: string, body: SafeHtml, active?: string): void {
  res.send(layout({ title, user: req.user, body, flash: takeFlash(req), active }));
}

export function back(req: Request, fallback: string): string {
  const ref = req.get("referer");
  if (!ref) return fallback;
  try {
    const u = new URL(ref);
    if (u.host === req.get("host")) return u.pathname + u.search;
  } catch {
    // ignore
  }
  return fallback;
}
