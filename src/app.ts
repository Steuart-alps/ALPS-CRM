import express, { type Request, type Response, type NextFunction } from "express";
import session from "express-session";
import connectPg from "connect-pg-simple";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool, query, one } from "./db.ts";
import { authRouter, loadUser, requireUser } from "./auth.ts";
import { html, layout } from "./html.ts";
import { NotFound } from "./util.ts";
import { clientsRouter } from "./routes/clients.ts";
import { visitsRouter } from "./routes/visits.ts";
import { workRouter } from "./routes/work.ts";
import { quotesRouter } from "./routes/quotes.ts";
import { documentsRouter } from "./routes/documents.ts";
import { overviewRouter } from "./routes/overview.ts";
import { settingsRouter } from "./routes/settings.ts";
import { exportsRouter } from "./routes/exports.ts";
import { gapsRouter } from "./routes/gaps.ts";
import { respondRouter } from "./invites.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Loads the ALPS master formats the first time the CRM starts. */
export async function seedTemplates(): Promise<void> {
  const n = await one<{ n: number }>("select count(*)::int as n from doc_templates");
  if (n && n.n > 0) return;
  const masters: [string, string, string][] = [
    ["Risk assessment master (Greenkeeping RA Pack July 2026 v2)", "master-risk-assessment.docx", "ra"],
    ["SOP master (SOP-PS-BATTERY-001)", "master-sop.docx", "sop"],
  ];
  for (const [name, file, kind] of masters) {
    try {
      const content = await readFile(path.join(root, "templates", file));
      await query("insert into doc_templates (name, filename, content, kind) values ($1, $2, $3, $4)", [name, file, content, kind]);
    } catch (err) {
      console.error(`could not load template ${file}`, err);
    }
  }
}

/** Blocks form posts that come from another website. */
function sameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const host = req.get("host");
  const origin = req.get("origin") ?? req.get("referer");
  try {
    if (origin && host && new URL(origin).host === host) return next();
  } catch {
    // fall through
  }
  res.status(403).send("This form has to be sent from the CRM itself.");
}

export function createApp(): express.Express {
  const app = express();
  const production = process.env.NODE_ENV === "production";
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use((_req, res, next) => {
    res.set({
      "content-security-policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
      ...(production ? { "strict-transport-security": "max-age=31536000" } : {}),
    });
    next();
  });

  app.get("/healthz", async (_req, res) => {
    await pool.query("select 1");
    res.json({ ok: true });
  });
  app.use("/static", express.static(path.join(root, "public"), { maxAge: "1h" }));

  const PgStore = connectPg(session);
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  app.use(
    session({
      store: new PgStore({ pool, tableName: "session", createTableIfMissing: false, pruneSessionInterval: 60 * 60 }),
      secret,
      name: "alpscrm",
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: "lax", secure: production, maxAge: 12 * 60 * 60 * 1000 },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "200kb" }));
  app.use(sameOrigin);
  app.use(loadUser);

  app.use(authRouter());
  app.use(exportsRouter());
  app.use(respondRouter());
  app.use(requireUser);
  app.use(overviewRouter());
  app.use(clientsRouter());
  app.use(visitsRouter());
  app.use(workRouter());
  app.use(quotesRouter());
  app.use(documentsRouter());
  app.use(settingsRouter());
  app.use(gapsRouter());

  app.use((req, res) => {
    res.status(404).send(layout({ title: "Not found", user: req.user, body: html`<h1>That page doesn't exist</h1><p><a href="/">Back to Today</a></p>` }));
  });
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof NotFound) {
      return res.status(404).send(layout({ title: "Not found", user: req.user, body: html`<h1>That record doesn't exist</h1><p><a href="/">Back to Today</a></p>` }));
    }
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).send(layout({ title: "Too big", user: req.user, body: html`<h1>That file is too big</h1><p>Files can be up to 15 MB.</p>` }));
    }
    console.error(err);
    res.status(500).send(layout({ title: "Error", user: req.user, body: html`<h1>Something went wrong</h1><p>Try again. If it keeps happening, tell Steuart.</p>` }));
  });
  return app;
}
