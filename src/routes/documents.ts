import { Router } from "express";
import multer from "multer";
import { one, query } from "../db.ts";
import { html, ukDate, todayUk, opt, type SafeHtml } from "../html.ts";
import { s, int, dateOrNull, idParam, page, NotFound } from "../util.ts";
import { requireOwner, setFlash } from "../auth.ts";
import { officeUser, activeUsers } from "../lookups.ts";
import { checkTemplate, fillTemplate, mergeData, MERGE_FIELDS, templateList } from "../docgen.ts";
import { notifyAssigned } from "../notify.ts";

const MAX_BYTES = 15 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

const ALLOWED = new Map<string, string>([
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["doc", "application/msword"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["xls", "application/vnd.ms-excel"],
  ["pdf", "application/pdf"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
]);

export const DOC_KIND: Record<string, string> = { ra: "Risk assessment", sop: "SOP", other: "Other document" };

export const DEPARTMENTS = [
  "Bar", "Kitchen", "Front of house", "Restaurant", "Housekeeping", "Reception", "Maintenance",
  "Greenkeeping", "Pro-shop", "Spa and leisure", "Pool", "Office", "Retail", "Warehouse", "Grounds", "Events",
];

export const DOC_STATUS: Record<string, string> = {
  requested: "To create",
  ready: "Ready for checking",
  returned: "Sent back",
  approved: "Approved",
  cancelled: "Cancelled",
};

function statusChip(st: string): SafeHtml {
  const cls = st === "approved" ? "good" : st === "ready" ? "warn" : st === "returned" ? "bad" : "";
  return html`<span class="chip ${cls}">${DOC_STATUS[st] ?? st}</span>`;
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
  return cleaned || "document";
}

function disposition(name: string): string {
  const ascii = safeFilename(name).replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safeFilename(name))}`;
}

export function documentsRouter(): Router {
  const r = Router();

  r.get("/documents", async (req, res) => {
    const view = typeof req.query.view === "string" ? req.query.view : req.user!.role === "owner" ? "checking" : "mine";
    const where =
      view === "mine" ? "d.assigned_to = $1 and d.status in ('requested', 'returned')"
      : view === "checking" ? "d.status = 'ready' and $1::int is not null"
      : view === "open" ? "d.status in ('requested', 'returned', 'ready') and $1::int is not null"
      : "$1::int is not null";
    const [rows, clients, users, templates] = await Promise.all([
      query(
        `select d.*, c.name as client_name, u.name as assignee, rq.name as requester
           from doc_requests d join clients c on c.id = d.client_id
           left join users u on u.id = d.assigned_to left join users rq on rq.id = d.requested_by
          where ${where} order by d.due_on nulls last, d.id desc limit 300`,
        [req.user!.id],
      ),
      query("select id, name from clients where status <> 'former' order by lower(name)"),
      activeUsers(),
      templateList(),
    ]);
    const today = todayUk();
    const tab = (k: string, label: string) => html`<a class="button ${view === k ? "" : "secondary"} small" href="/documents?view=${k}">${label}</a>`;
    const preClient = int(req.query.client);
    const staff = officeUser(users);
    page(req, res, "Documents", html`
<div class="spread"><h1>Document requests</h1>
  <div class="row">${tab("mine", "For me to create")}${tab("checking", "Ready for checking")}${tab("open", "All open")}${tab("all", "Everything")}
  ${req.user!.role === "owner" ? html`<a class="small" href="/documents/templates">Word templates</a>` : ""}</div></div>
<div class="table-wrap"><table>
  <thead><tr><th>Document</th><th>Client</th><th>For</th><th>Due</th><th>Status</th></tr></thead>
  <tbody>${rows.map((d) => html`<tr>
    <td><a href="/documents/${d.id}">${d.title}</a><br><span class="small muted">${DOC_KIND[d.kind]}${d.department ? ` · ${d.department}` : ""} · asked by ${d.requester ?? "?"}</span></td>
    <td><a href="/clients/${d.client_id}">${d.client_name}</a></td>
    <td>${d.assignee ?? ""}</td>
    <td>${d.due_on ? html`<span class="${d.due_on < today && !["approved", "cancelled"].includes(d.status) ? "overdue" : ""}">${ukDate(d.due_on)}</span>` : ""}</td>
    <td>${statusChip(d.status)}</td></tr>`)}
  ${rows.length === 0 ? html`<tr><td colspan="5" class="muted">Nothing here.</td></tr>` : ""}</tbody>
</table></div>
<section class="card" style="margin-top:1rem">
  <h2>Request a document</h2>
  <form method="post" action="/documents" class="stack">
    <div class="fields">
      <label>Client <select name="client_id" required><option value="">Choose…</option>${clients.map((c) => opt(c.id, c.name, preClient))}</select></label>
      <label>Type <select name="kind">${Object.entries(DOC_KIND).map(([k, v]) => opt(k, v, "ra"))}</select></label>
      <label>Department <input name="department" list="departments" required placeholder="e.g. Bar"></label>
      <datalist id="departments">${DEPARTMENTS.map((d) => html`<option value="${d}">`)}</datalist>
      <label>Title (optional) <input name="title" placeholder="e.g. Cellar and keg handling"></label>
      <label>Master format <select name="template_id"><option value="">Match the type</option>${templates.filter((t) => t.active).map((t) => opt(t.id, t.name, null))}</select></label>
      <label>Who creates it <select name="assigned_to">${users.map((u) => opt(u.id, u.name, staff?.id ?? req.user!.id))}</select></label>
      <label>Due <input type="date" name="due_on"></label>
    </div>
    <label>What's needed <textarea name="notes" placeholder="Anything they should include or check"></textarea></label>
    <div><button>Send request</button></div>
  </form>
</section>`, "documents");
  });

  r.post("/documents", async (req, res) => {
    const clientId = int(req.body.client_id);
    const kind = Object.keys(DOC_KIND).includes(String(req.body.kind)) ? String(req.body.kind) : "ra";
    const department = s(req.body.department);
    if (!clientId || !department) {
      setFlash(req, "Choose a client and the department the document is for.");
      return res.redirect("/documents");
    }
    const extra = s(req.body.title);
    const title = `${department} ${kind === "ra" ? "risk assessment" : kind === "sop" ? "SOP" : "document"}${extra ? `: ${extra}` : ""}`;
    let templateId = int(req.body.template_id);
    if (!templateId) {
      const t = await one<{ id: number }>("select id from doc_templates where active and kind = $1 order by id limit 1", [kind]);
      templateId = t?.id ?? null;
    }
    const assignedTo = int(req.body.assigned_to);
    const dueOn = dateOrNull(req.body.due_on);
    const row = await one<{ id: number }>(
      `insert into doc_requests (client_id, title, kind, department, template_id, requested_by, assigned_to, due_on, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [clientId, title, kind, department, templateId, req.user!.id, assignedTo, dueOn, s(req.body.notes)],
    );
    await notifyAssigned({ assigneeId: assignedTo, byUserId: req.user!.id, kind: "document", title, clientId, dueOn, path: `/documents/${row!.id}` });
    setFlash(req, "Request sent.");
    res.redirect(`/documents/${row!.id}`);
  });

  // ---- Word templates (owner) ----
  r.get("/documents/templates", requireOwner, async (req, res) => {
    const ts = await templateList();
    page(req, res, "Word templates", html`
<h1>Word templates</h1>
<p>These are the master formats documents are created from. Use Word's ordinary mail-merge fields (Mailings, Insert Merge Field), named like the columns of your old client spreadsheet, for example <code>Company_Name</code>. When Ayesha or anyone creates a document, each field becomes that client's detail. <code>[Client / Site Name]</code> in the text is filled in too. Prices are never filled in.</p>
<div class="grid">
<section class="card">
  <h2>Templates</h2>
  <ul class="list">${ts.map((t) => html`<li><strong>${t.name}</strong> <span class="chip">${DOC_KIND[t.kind]}</span> <span class="small muted">${t.filename}</span> ${t.active ? "" : html`<span class="chip">Hidden</span>`}
    <form method="post" action="/documents/templates/${t.id}/toggle" class="row small"><a href="/documents/templates/${t.id}/download">Download</a>
    <button class="small secondary">${t.active ? "Hide" : "Show again"}</button></form></li>`)}
  ${ts.length === 0 ? html`<li class="muted">No templates yet.</li>` : ""}</ul>
  <form method="post" action="/documents/templates" enctype="multipart/form-data" class="stack">
    <label>Name <input name="name" required placeholder="e.g. Kitchen risk assessment master"></label>
    <label>Used for <select name="kind">${Object.entries(DOC_KIND).map(([k, v]) => opt(k, v, "ra"))}</select></label>
    <label>Word file (.docx) <input type="file" name="file" accept=".docx" required></label>
    <div><button>Upload template</button></div>
  </form>
</section>
<section class="card">
  <h2>Merge fields you can use</h2>
  <table><tbody>${MERGE_FIELDS.map(([k, d]) => html`<tr><td><code>${k}</code></td><td class="small">${d}</td></tr>`)}</tbody></table>
</section>
</div>`, "documents");
  });

  r.post("/documents/templates", requireOwner, upload.single("file"), async (req, res) => {
    const f = req.file;
    const name = s(req.body.name);
    if (!f || !name || !/\.docx$/i.test(f.originalname)) {
      setFlash(req, "Give the template a name and choose a .docx Word file.");
      return res.redirect("/documents/templates");
    }
    try {
      checkTemplate(f.buffer);
    } catch (err: any) {
      setFlash(req, err.message);
      return res.redirect("/documents/templates");
    }
    const kind = Object.keys(DOC_KIND).includes(String(req.body.kind)) ? String(req.body.kind) : "other";
    await query("insert into doc_templates (name, filename, content, kind, uploaded_by) values ($1, $2, $3, $4, $5)", [
      name, safeFilename(f.originalname), f.buffer, kind, req.user!.id,
    ]);
    setFlash(req, `Template "${name}" added.`);
    res.redirect("/documents/templates");
  });

  r.post("/documents/templates/:id/toggle", requireOwner, async (req, res) => {
    await query("update doc_templates set active = not active where id = $1", [idParam(req)]);
    res.redirect("/documents/templates");
  });

  r.get("/documents/templates/:id/download", async (req, res) => {
    const t = await one<{ filename: string; content: Buffer }>("select filename, content from doc_templates where id = $1", [idParam(req)]);
    if (!t) throw new NotFound();
    res.set("content-type", ALLOWED.get("docx")!).set("content-disposition", disposition(t.filename)).send(t.content);
  });

  // ---- One request ----
  r.get("/documents/:id", async (req, res) => {
    const id = idParam(req);
    const d = await one(
      `select d.*, c.name as client_name, u.name as assignee, rq.name as requester, ap.name as approver, t.name as template_name
         from doc_requests d join clients c on c.id = d.client_id
         left join users u on u.id = d.assigned_to left join users rq on rq.id = d.requested_by
         left join users ap on ap.id = d.approved_by left join doc_templates t on t.id = d.template_id
        where d.id = $1`,
      [id],
    );
    if (!d) throw new NotFound();
    const [files, templates, users] = await Promise.all([
      query(`select f.id, f.filename, f.size, f.created_at, u.name as uploader from doc_files f
              left join users u on u.id = f.uploaded_by where f.request_id = $1 order by f.created_at desc`, [id]),
      templateList(),
      activeUsers(),
    ]);
    const isOwner = req.user!.role === "owner";
    const canWork = ["requested", "returned"].includes(d.status);
    page(req, res, d.title, html`
<div class="spread"><div><h1>${d.title} ${statusChip(d.status)}</h1>
  <div class="muted">${DOC_KIND[d.kind]}${d.department ? ` · ${d.department}` : ""} · for <a href="/clients/${d.client_id}">${d.client_name}</a> · asked by ${d.requester ?? "?"} ${ukDate(d.created_at)}${d.due_on ? ` · due ${ukDate(d.due_on)}` : ""}</div></div>
  <a href="/documents">All document requests</a></div>
${d.status === "returned" && d.review_note ? html`<p class="error"><strong>Sent back:</strong> ${d.review_note}</p>` : ""}
${d.status === "approved" ? html`<p class="flash">Approved by ${d.approver ?? "?"} on ${ukDate(d.approved_at)}.</p>` : ""}
<div class="grid">
<section class="card">
  <h2>1. Create it</h2>
  ${d.notes ? html`<p style="white-space:pre-wrap">${d.notes}</p>` : html`<p class="muted">No extra notes.</p>`}
  <form method="get" action="/documents/${id}/create" class="stack">
    <label>Template <select name="template">${templates.filter((t) => t.active || t.id === d.template_id).map((t) => opt(t.id, t.name, d.template_id))}</select></label>
    ${templates.length ? html`<div><button class="secondary">Download it with ${d.client_name}'s details filled in</button></div>`
      : html`<p class="small muted">No Word templates yet${isOwner ? html`: <a href="/documents/templates">add one</a>` : ""}.</p>`}
  </form>
  <p class="small muted">Finish the document in Word, then upload it below.</p>
</section>
<section class="card">
  <h2>2. Upload the finished document</h2>
  <ul class="list">${files.map((f) => html`<li><a href="/files/${f.id}">${f.filename}</a> <span class="small muted">${Math.ceil(f.size / 1024)} KB · ${f.uploader ?? ""} · ${ukDate(f.created_at)}</span></li>`)}
  ${files.length === 0 ? html`<li class="muted">Nothing uploaded yet.</li>` : ""}</ul>
  ${d.status !== "approved" && d.status !== "cancelled" ? html`<form method="post" action="/documents/${id}/files" enctype="multipart/form-data" class="stack">
    <input type="file" name="file" required accept=".docx,.doc,.pdf,.xlsx,.xls,.pptx,.jpg,.jpeg,.png" aria-label="File">
    <div><button class="secondary">Upload</button></div>
  </form>` : ""}
</section>
</div>
<section class="card">
  <h2>3. ${isOwner ? "Check it" : "Send for checking"}</h2>
  <form method="post" action="/documents/${id}/status" class="stack">
    ${canWork ? html`<div class="row"><button name="action" value="ready"${files.length ? "" : " disabled"}>Ready for checking</button>
      ${files.length ? "" : html`<span class="small muted">Upload the document first.</span>`}</div>` : ""}
    ${isOwner && d.status === "ready" ? html`
      <label>Note if sending back <textarea name="review_note" placeholder="What needs changing"></textarea></label>
      <div class="row"><button name="action" value="approve">Approve</button><button name="action" value="return" class="secondary">Send back</button></div>` : ""}
    ${d.status === "ready" && !isOwner ? html`<p class="muted">Waiting for the owner to check it.</p>` : ""}
    <details class="small"><summary>Change who creates it or the due date</summary>
      <div class="fields">
        <label>Who creates it <select name="assigned_to">${users.map((u) => opt(u.id, u.name, d.assigned_to))}</select></label>
        <label>Due <input type="date" name="due_on" value="${d.due_on ?? ""}"></label>
      </div>
      <div class="row"><button name="action" value="update" class="small secondary">Save</button>
      ${d.status !== "cancelled" && d.status !== "approved" ? html`<button name="action" value="cancel" class="small secondary" data-confirm="Cancel this request?">Cancel request</button>` : ""}</div>
    </details>
  </form>
</section>`, "documents");
  });

  r.get("/documents/:id/create", async (req, res) => {
    const d = await one<{ client_id: number; title: string; template_id: number | null; department: string | null }>(
      "select client_id, title, template_id, department from doc_requests where id = $1", [idParam(req)]);
    if (!d) throw new NotFound();
    const tid = int(req.query.template) ?? d.template_id;
    const t = tid ? await one<{ content: Buffer }>("select content from doc_templates where id = $1", [tid]) : undefined;
    if (!t) {
      setFlash(req, "Choose a template.");
      return res.redirect(`/documents/${idParam(req)}`);
    }
    const client = await one<{ name: string }>("select name from clients where id = $1", [d.client_id]);
    const out = fillTemplate(t.content, await mergeData(d.client_id, d.department));
    res.set("content-type", ALLOWED.get("docx")!)
      .set("content-disposition", disposition(`${d.title} - ${client?.name ?? ""}.docx`))
      .send(out);
  });

  r.post("/documents/:id/files", upload.single("file"), async (req, res) => {
    const id = idParam(req);
    const f = req.file;
    const ext = f?.originalname.split(".").pop()?.toLowerCase() ?? "";
    if (!f || !ALLOWED.has(ext)) {
      setFlash(req, "Choose a Word, Excel, PowerPoint, PDF or picture file.");
      return res.redirect(`/documents/${id}`);
    }
    const d = await one("select id from doc_requests where id = $1 and status not in ('approved', 'cancelled')", [id]);
    if (!d) throw new NotFound();
    await query("insert into doc_files (request_id, filename, mime, size, content, uploaded_by) values ($1, $2, $3, $4, $5, $6)", [
      id, safeFilename(f.originalname), ALLOWED.get(ext), f.size, f.buffer, req.user!.id,
    ]);
    setFlash(req, "Uploaded.");
    res.redirect(`/documents/${id}`);
  });

  r.get("/files/:id", async (req, res) => {
    const f = await one<{ filename: string; mime: string; content: Buffer }>("select filename, mime, content from doc_files where id = $1", [idParam(req)]);
    if (!f) throw new NotFound();
    res.set("content-type", f.mime).set("content-disposition", disposition(f.filename)).set("x-content-type-options", "nosniff").send(f.content);
  });

  r.post("/documents/:id/status", async (req, res) => {
    const id = idParam(req);
    const d = await one("select * from doc_requests where id = $1", [id]);
    if (!d) throw new NotFound();
    const action = String(req.body.action ?? "");
    const isOwner = req.user!.role === "owner";
    const log = (body: string) =>
      query("insert into activities (client_id, user_id, kind, body) values ($1, $2, 'note', $3)", [d.client_id, req.user!.id, body]);
    if (action === "ready" && ["requested", "returned"].includes(d.status)) {
      await query("update doc_requests set status = 'ready', updated_at = now() where id = $1", [id]);
      setFlash(req, "Sent for checking.");
    } else if (action === "approve" && isOwner && d.status === "ready") {
      await query("update doc_requests set status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() where id = $1", [id, req.user!.id]);
      await log(`Document approved: ${d.title}`);
      setFlash(req, "Approved.");
    } else if (action === "return" && isOwner && d.status === "ready") {
      await query("update doc_requests set status = 'returned', review_note = $2, updated_at = now() where id = $1", [id, s(req.body.review_note)]);
      setFlash(req, "Sent back.");
    } else if (action === "update") {
      const assignedTo = int(req.body.assigned_to);
      await query("update doc_requests set assigned_to = $2, due_on = $3, updated_at = now() where id = $1", [id, assignedTo, dateOrNull(req.body.due_on)]);
      if (assignedTo !== d.assigned_to) {
        await notifyAssigned({ assigneeId: assignedTo, byUserId: req.user!.id, kind: "document", title: d.title, clientId: d.client_id, dueOn: dateOrNull(req.body.due_on), path: `/documents/${id}` });
      }
      setFlash(req, "Saved.");
    } else if (action === "cancel" && !["approved", "cancelled"].includes(d.status)) {
      await query("update doc_requests set status = 'cancelled', updated_at = now() where id = $1", [id]);
      setFlash(req, "Request cancelled.");
    }
    res.redirect(`/documents/${id}`);
  });

  return r;
}
