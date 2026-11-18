import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { timingSafeEqual } from "node:crypto";
import { one, query } from "./db.ts";
import { html, layout } from "./html.ts";

export type User = {
  id: number;
  name: string;
  email: string;
  role: "owner" | "staff";
  active: boolean;
  totp_enabled: boolean;
};

declare module "express-session" {
  interface SessionData {
    userId?: number;
    /** Password checked, waiting for the 2FA code. */
    pendingUserId?: number;
    pendingTotpSecret?: string;
    flash?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export const MIN_PASSWORD = 12;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

export function setFlash(req: Request, message: string): void {
  req.session.flash = message;
}

export function takeFlash(req: Request): string | null {
  const f = req.session.flash ?? null;
  delete req.session.flash;
  return f;
}

export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.session.userId) {
    const u = await one<User>(
      "select id, name, email, role, active, totp_enabled from users where id = $1",
      [req.session.userId],
    );
    if (u && u.active) req.user = u;
    else delete req.session.userId;
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.redirect("/login");
    return;
  }
  next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.redirect("/login");
    return;
  }
  if (req.user.role !== "owner") {
    res.status(403).send(layout({ title: "Not allowed", user: req.user, body: html`<h1>Only the owner can do that</h1>` }));
    return;
  }
  next();
}

// Simple in-memory brake on password and code guessing: 8 failures per
// email or IP in 15 minutes locks that key for the rest of the window.
const failures = new Map<string, { count: number; until: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;

function isLocked(keys: string[]): boolean {
  const now = Date.now();
  return keys.some((k) => {
    const f = failures.get(k);
    return f !== undefined && f.until > now && f.count >= MAX_FAILS;
  });
}

function recordFailure(keys: string[]): void {
  const now = Date.now();
  for (const k of keys) {
    const f = failures.get(k);
    if (!f || f.until < now) failures.set(k, { count: 1, until: now + WINDOW_MS });
    else f.count++;
  }
}

function clearFailures(keys: string[]): void {
  for (const k of keys) failures.delete(k);
}

export function resetRateLimits(): void {
  failures.clear();
}

function totpFor(secretBase32: string, email: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: "ALPS CRM",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

function codeOk(secret: string, email: string, code: string): boolean {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  return totpFor(secret, email).validate({ token: clean, window: 1 }) !== null;
}

function loginPage(error?: string): string {
  return layout({
    title: "Sign in",
    body: html`<div class="login card">
  <h1>ALPS CRM</h1>
  ${error ? html`<p class="error">${error}</p>` : ""}
  <form method="post" action="/login" class="stack">
    <label>Email <input type="email" name="email" autocomplete="username" required autofocus></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <button>Sign in</button>
  </form>
</div>`,
  });
}

function setupTokenMatches(given: string): boolean {
  const expected = process.env.SETUP_TOKEN ?? "";
  if (expected.length < 16) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authRouter(): Router {
  const r = Router();

  r.get("/login", async (req, res) => {
    if (req.user) return res.redirect("/");
    const count = await one<{ n: number }>("select count(*)::int as n from users");
    if (count && count.n === 0) return res.redirect("/setup");
    res.send(loginPage());
  });

  r.post("/login", async (req, res) => {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    const keys = [`email:${email}`, `ip:${req.ip}`];
    if (isLocked(keys)) {
      return res.status(429).send(loginPage("Too many attempts. Wait 15 minutes and try again."));
    }
    const u = await one<{ id: number; password_hash: string; active: boolean }>(
      "select id, password_hash, active from users where email = $1",
      [email],
    );
    // Compare against a dummy hash when the email is unknown so timing does not reveal it.
    const hash = u?.password_hash ?? DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);
    if (!u || !ok || !u.active) {
      recordFailure(keys);
      return res.status(401).send(loginPage("That email and password don't match."));
    }
    clearFailures([`email:${email}`]);
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.pendingUserId = u.id;
      res.redirect("/login/code");
    });
  });

  // Second step: the 6-digit code, or setting up the authenticator app the first time.
  r.get("/login/code", async (req, res) => {
    const id = req.session.pendingUserId;
    if (!id) return res.redirect("/login");
    const u = await one<{ email: string; totp_enabled: boolean }>("select email, totp_enabled from users where id = $1", [id]);
    if (!u) return res.redirect("/login");
    if (u.totp_enabled) {
      return res.send(layout({
        title: "Enter code",
        body: html`<div class="login card">
  <h1>Enter your code</h1>
  <p class="muted">Open your authenticator app and type the 6-digit code for ALPS CRM.</p>
  <form method="post" action="/login/code" class="stack">
    <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required autofocus></label>
    <button>Continue</button>
  </form>
</div>`,
      }));
    }
    if (!req.session.pendingTotpSecret) req.session.pendingTotpSecret = new OTPAuth.Secret({ size: 20 }).base32;
    const totp = totpFor(req.session.pendingTotpSecret, u.email);
    const qr = await QRCode.toDataURL(totp.toString(), { margin: 1, width: 220 });
    res.send(layout({
      title: "Set up sign-in code",
      body: html`<div class="login card">
  <h1>Set up your sign-in code</h1>
  <p>Client details are private, so every sign-in needs a code from your phone as well as your password.</p>
  <ol class="small">
    <li>Install an authenticator app (Google Authenticator, Microsoft Authenticator or 1Password).</li>
    <li>Scan this code with it.</li>
    <li>Type the 6-digit code the app shows.</li>
  </ol>
  <img class="qr" src="${qr}" alt="QR code for your authenticator app">
  <p class="small muted">Can't scan? Enter this key instead: <code>${req.session.pendingTotpSecret}</code></p>
  <form method="post" action="/login/code" class="stack">
    <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
    <button>Finish</button>
  </form>
</div>`,
    }));
  });

  r.post("/login/code", async (req, res) => {
    const id = req.session.pendingUserId;
    if (!id) return res.redirect("/login");
    const keys = [`code:${id}`, `ip:${req.ip}`];
    if (isLocked(keys)) {
      return res.status(429).send(layout({ title: "Wait", body: html`<div class="login card"><p class="error">Too many attempts. Wait 15 minutes and <a href="/login">sign in again</a>.</p></div>` }));
    }
    const u = await one<{ id: number; email: string; totp_secret: string | null; totp_enabled: boolean }>(
      "select id, email, totp_secret, totp_enabled from users where id = $1 and active",
      [id],
    );
    if (!u) return res.redirect("/login");
    const code = String(req.body.code ?? "");
    const secret = u.totp_enabled ? u.totp_secret : req.session.pendingTotpSecret;
    if (!secret || !codeOk(secret, u.email, code)) {
      recordFailure(keys);
      setFlash(req, "That code didn't work. Check the time on your phone is right and try the newest code.");
      return res.redirect("/login/code");
    }
    clearFailures([`code:${id}`]);
    if (!u.totp_enabled) {
      await query("update users set totp_secret = $1, totp_enabled = true where id = $2", [secret, u.id]);
    }
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = u.id;
      res.redirect("/");
    });
  });

  r.post("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });

  // First run only: creates the owner account. Needs SETUP_TOKEN from the
  // hosting settings so nobody else can claim an empty CRM.
  r.get("/setup", async (_req, res) => {
    const count = await one<{ n: number }>("select count(*)::int as n from users");
    if (count && count.n > 0) return res.redirect("/login");
    res.send(layout({
      title: "First set-up",
      body: html`<div class="login card">
  <h1>Create the owner account</h1>
  <p class="muted small">Copy the set-up token from the CRM's Environment page on Render.</p>
  <form method="post" action="/setup" class="stack">
    <label>Set-up token <input name="token" required autocomplete="off"></label>
    <label>Your name <input name="name" required></label>
    <label>Email <input type="email" name="email" required autocomplete="username"></label>
    <label>Password (at least ${MIN_PASSWORD} characters) <input type="password" name="password" minlength="${MIN_PASSWORD}" required autocomplete="new-password"></label>
    <button>Create account</button>
  </form>
</div>`,
    }));
  });

  r.post("/setup", async (req, res) => {
    const count = await one<{ n: number }>("select count(*)::int as n from users");
    if (count && count.n > 0) return res.redirect("/login");
    if (isLocked([`ip:${req.ip}`])) return res.status(429).send("Too many attempts");
    if (!setupTokenMatches(String(req.body.token ?? ""))) {
      recordFailure([`ip:${req.ip}`]);
      return res.status(403).send(layout({ title: "Set-up", body: html`<div class="login card"><p class="error">That set-up token isn't right.</p><a href="/setup">Try again</a></div>` }));
    }
    const name = String(req.body.name ?? "").trim();
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    if (!name || !email.includes("@") || password.length < MIN_PASSWORD) {
      return res.status(400).send(layout({ title: "Set-up", body: html`<div class="login card"><p class="error">Fill in every box, with a password of at least ${MIN_PASSWORD} characters.</p><a href="/setup">Back</a></div>` }));
    }
    await query(
      "insert into users (name, email, password_hash, role) values ($1, $2, $3, 'owner')",
      [name, email, await hashPassword(password)],
    );
    res.redirect("/login");
  });

  return r;
}

