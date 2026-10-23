import { db } from "../db";
import { channelMembers, channels, users } from "../../src/db/schema";

export async function seedWorld() {
  await db.insert(users).values([
    { id: "UOWN", name: "Olive", role: "owner" },
    { id: "UADM", name: "Adam", role: "admin" },
    { id: "UMEM", name: "Mia", role: "member" },
    { id: "UMEM2", name: "Max", role: "member" },
    { id: "UGONE", name: "Gone", role: "member", deactivated: true },
  ]);
  await db.insert(channels).values([
    { id: "CPUB", name: "general", isPrivate: false, botIsMember: true },
    { id: "CPUBNOBOT", name: "lonely", isPrivate: false, botIsMember: false },
    { id: "CPRIV", name: "secret", isPrivate: true, botIsMember: true },
  ]);
  await db.insert(channelMembers).values({ channelId: "CPRIV", userId: "UMEM" });
}

export type Calls = { posts: any[]; turns: any[]; research: any[] };

/** Configurable fake Slack WebClient: info() decides conversations.info's response. */
export function fakeSlack(calls: Calls, info: () => any = () => ({ ok: true, channel: { id: "C", is_member: true, is_private: false } })) {
  return {
    conversations: {
      info: async () => info(),
      open: async () => ({ ok: true, channel: { id: "DDM" } }),
    },
    chat: {
      postMessage: async (a: any) => {
        calls.posts.push(a);
        return { ok: true };
      },
    },
  } as any;
}
