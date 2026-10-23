/** Late-bound hook so approval/lease can start a continuation turn without a static import cycle with index.ts. */
export type FollowUpInput = { channelId: string; threadTs: string | null; userId: string; text: string };
let handler: ((i: FollowUpInput) => Promise<void>) | undefined;
export const setFollowUp = (f?: (i: FollowUpInput) => Promise<void>) => { handler = f; };
export const followUp = async (i: FollowUpInput) => {
  // After a restart a block action can arrive before any turn ran; loading index registers the real handler.
  if (!handler) await import("./index");
  await handler?.(i);
};
