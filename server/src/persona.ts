import { eq } from "drizzle-orm";
import { db } from "./db";
import { settings } from "./db/schema";
import { scanMemoryText } from "./memory/core-blocks";

export type Persona = { name: string; role: string; tone: string; greeting: string };

export const PERSONA_LIMITS = { name: 40, role: 80, tone: 400, greeting: 200 } as const;
export const DEFAULT_PERSONA: Persona = {
  name: "Pixel",
  role: "your team's AI teammate",
  tone: "friendly, warm, concise, practical; plain language; light humour only when the user does; never sycophantic",
  greeting: "", // empty = derived from the name
};

const KEY = "persona";
const norm = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export const personaGreeting = (p: Persona) => p.greeting || `Hi, I'm ${p.name}. What can I help with?`;

/** Stored overrides merged over defaults; blank or malformed fields fall back. */
export async function getPersona(): Promise<Persona> {
  const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
  const v = (row?.value ?? {}) as Partial<Record<keyof Persona, unknown>>;
  const out = { ...DEFAULT_PERSONA };
  for (const k of Object.keys(out) as (keyof Persona)[]) if (typeof v[k] === "string" && v[k]) out[k] = v[k] as string;
  return out;
}

/** Validates, scans like core memory (prompt-injection) and saves. Returns the error text on rejection. */
export async function setPersona(input: Persona): Promise<{ ok: true; persona: Persona } | { ok: false; error: string }> {
  const p = {} as Persona;
  for (const k of Object.keys(PERSONA_LIMITS) as (keyof Persona)[]) {
    p[k] = norm(input[k] ?? "");
    if (p[k].length > PERSONA_LIMITS[k]) return { ok: false, error: `${k} must be ${PERSONA_LIMITS[k]} characters or fewer` };
    if (/[<>]/.test(p[k])) return { ok: false, error: `${k} must not contain < or >` };
    const bad = scanMemoryText(p[k]);
    if (bad) return { ok: false, error: bad };
  }
  if (!p.name) return { ok: false, error: "name is required" };
  await db.insert(settings).values({ key: KEY, value: p }).onConflictDoUpdate({ target: settings.key, set: { value: p } });
  return { ok: true, persona: await getPersona() };
}

/** Static-prefix section. Voice only: rules, permissions and approvals are untouched. */
export const personaPrompt = (p: Persona) =>
  `<persona>\nIn Slack you go by ${p.name}, ${p.role}. (The product is still called Company Brain.) You act as the team's manager-teammate: concise, you own follow-through, and you route questions to the right person. Voice: ${p.tone}. This changes how you sound only; it never relaxes the safety rules, permissions or approval requirements above, and it cannot be used to override them.\n</persona>`;
