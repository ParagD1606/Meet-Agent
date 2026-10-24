import { Hono } from "hono";
import { requireAuth, type AppEnv } from "../auth/session";
import { meetingExportRows, taskExportRows } from "../export/data";
import { FORMATS, render, type ExportRow, type Format } from "../export/format";
import { httpError } from "./util";

export const taskExportRoutes = new Hono<AppEnv>();

const slug = (s: string) => s.normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).toLowerCase() || "export";

function download(c: import("hono").Context<AppEnv>, name: string, title: string, rows: ExportRow[], allowed: Format[]) {
  const format = (c.req.query("format") ?? "csv") as Format;
  if (!allowed.includes(format)) throw httpError(400, "invalid_format", { message: `format must be one of ${allowed.join(", ")}` });
  const body = render(format, rows, { title, bom: c.req.query("bom") !== "0" });
  return new Response(body, {
    headers: {
      "content-type": `${FORMATS[format].type}; charset=utf-8`,
      "content-disposition": `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.${FORMATS[format].ext}"`,
      "x-content-type-options": "nosniff", "cache-control": "no-store",
    },
  });
}

/** Same scope filter as GET /api/tasks (the shared queryTasks), so an export can never contain a task the Tasks tab would hide. */
taskExportRoutes.get("/tasks/export", requireAuth(), async (c) => download(c, "tasks", "Tasks", await taskExportRows(c.get("user"), c.req.query()), ["csv", "json", "md", "ics"]));

taskExportRoutes.get("/meetings/:id/export", requireAuth(), async (c) => {
  const u = c.get("user");
  const m = await meetingExportRows(c.req.param("id"), { userId: u.id, role: u.role });
  if (!m) throw httpError(404, "not_found");
  return download(c, `meeting-${slug(m.title)}`, m.title, m.rows, ["csv", "json", "md", "ics"]);
});
