import { config } from "../config";
import { ghx, isLimited, retryAfter, type Cred } from "./github-api";
import { IntegrationError } from "./types";

export type ProjectMeta = { id: string; title: string; dueFieldId?: string; statusFieldId?: string; todoOptionId?: string };
export type ProjectRef = { owner: string; number: number };

const META = `query($login:String!,$number:Int!){repositoryOwner(login:$login){... on ProjectV2Owner{projectV2(number:$number){id title fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{options{id name}}}}}}}}`;
const ADD = `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`;
const SET = `mutation($project:ID!,$item:ID!,$field:ID!,$value:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:$value}){projectV2Item{id}}}`;

const cache = new Map<string, { at: number; meta: ProjectMeta }>();
const TTL = 60 * 60_000;
export const clearProjectCache = () => cache.clear();

const scopeHint = (c: Cred) => c.kind === "app"
  ? `the GitHub App needs "Organization projects: Read & write" (organization-owned projects only; an app installation cannot reach a personal project) at https://github.com/settings/apps/${config.GITHUB_APP_SLUG ?? "<app-slug>"}/permissions, approved by an organization owner`
  : "the token needs the `project` scope (classic) or Projects: read & write (fine-grained)";

/** One GraphQL call. HTTP and GraphQL errors both become an IntegrationError with the permission hint; secrets never appear. */
async function gql(c: Cred, query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await ghx(c.token, "POST", "/graphql", { query, variables });
  if (isLimited(r)) throw new IntegrationError("rate_limited", `GitHub rate limit reached${retryAfter(r) ? `; retry in ${retryAfter(r)}s` : ""}`, retryAfter(r));
  if (r.status === 401 || r.status === 403) throw new IntegrationError("unauthorized", `GitHub rejected the project request (${r.status}): ${scopeHint(c)}`);
  if (r.status !== 200) throw new IntegrationError("upstream", `GitHub projects request failed (${r.status})`);
  const errs = (r.data?.errors ?? []) as { type?: string; message?: string }[];
  if (errs.length) {
    const e = errs[0]!;
    if (e.type === "INSUFFICIENT_SCOPES" || /not accessible|scope|permission/i.test(e.message ?? "")) throw new IntegrationError("unauthorized", `GitHub refused the project request: ${scopeHint(c)}`);
    if (e.type === "NOT_FOUND") throw new IntegrationError("not_found", "project not found: check the owner and number, and that the credential can see it");
    throw new IntegrationError("invalid", `GitHub refused the project request (${(e.message ?? "error").slice(0, 120)})`);
  }
  return r.data?.data;
}

/** Project node id + the Due (DATE) and Status ('Todo') fields, cached for an hour. */
export async function projectMeta(c: Cred, p: ProjectRef): Promise<ProjectMeta> {
  const key = `${p.owner.toLowerCase()}/${p.number}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.meta;
  const d = await gql(c, META, { login: p.owner, number: p.number });
  const pr = d?.repositoryOwner?.projectV2;
  if (!pr?.id) throw new IntegrationError("not_found", "project not found: check the owner and number, and that the credential can see it");
  const fields = (pr.fields?.nodes ?? []) as { id?: string; name?: string; dataType?: string; options?: { id: string; name: string }[] }[];
  const due = fields.find((f) => f.id && f.name?.toLowerCase() === "due" && f.dataType === "DATE");
  const status = fields.find((f) => f.id && f.name?.toLowerCase() === "status" && f.dataType === "SINGLE_SELECT");
  const todo = status?.options?.find((o) => o.name.toLowerCase() === "todo" || o.name.toLowerCase() === "to do");
  const meta: ProjectMeta = { id: pr.id, title: pr.title ?? "", dueFieldId: due?.id, statusFieldId: todo ? status?.id : undefined, todoOptionId: todo?.id };
  cache.set(key, { at: Date.now(), meta });
  return meta;
}

/** Adds the issue to the project and fills Due / Status=Todo when those fields exist. Throws on the first failure; the caller reports it without failing the issue. */
export async function addToProject(c: Cred, p: ProjectRef, issueNodeId: string, due?: string): Promise<void> {
  const m = await projectMeta(c, p);
  const added = await gql(c, ADD, { project: m.id, content: issueNodeId });
  const item = added?.addProjectV2ItemById?.item?.id as string | undefined;
  if (!item) throw new IntegrationError("upstream", "GitHub did not return the project item");
  try {
    if (due && m.dueFieldId) await gql(c, SET, { project: m.id, item, field: m.dueFieldId, value: { date: due } });
    if (m.statusFieldId && m.todoOptionId) await gql(c, SET, { project: m.id, item, field: m.statusFieldId, value: { singleSelectOptionId: m.todoOptionId } });
  } catch (e) { throw new IntegrationError("upstream", `added to the project, but setting its fields failed: ${e instanceof IntegrationError ? e.message : "error"}`); }
}
