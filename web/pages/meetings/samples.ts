// Sample transcripts for the "Load sample" buttons (AMI-style "Name: text").
export const CLEAN_SAMPLE = `Ada: Okay, let's start. Goal for today is to lock the scope for the v2 onboarding launch.
Max: Quick status first. The signup flow is code complete, QA starts tomorrow.
Ada: Good. Priya, where are we on the pricing page copy?
Priya: Draft is done, legal still has to review it. I'll send it to them today.
Ada: Great. Can you also get their sign-off by next Wednesday?
Priya: Yes, I'll get legal sign-off by next Wednesday.
Marcus: On my side the analytics events are specced but not instrumented.
Ada: Marcus, please instrument the signup and activation events by the 14th.
Marcus: Sure, I'll take that. The 14th works.
Max: We also need a rollback plan if activation drops after launch.
Ada: Agreed. Max, you own the rollback plan. Write it up and share it by Friday.
Max: Will do, I'll share it Friday.
Ada: Decision time. Are we shipping the checklist in v2 or holding it for v2.1?
Marcus: Support says the checklist cuts tickets a lot, I'd ship it.
Priya: No objection from me, the copy is ready.
Ada: Okay, decision: the onboarding checklist ships in v2.
Max: Then QA needs the checklist build by Monday, I'll book their time.
Ada: Fine. Next topic, the beta cohort. Ten customers is enough?
Marcus: Ten is plenty, we only need signal on the first-run experience.
Ada: Decision: the beta cohort is ten customers, chosen by Priya.
Priya: Got it, I'll pick the ten accounts and send the list around on Thursday.
Max: One risk: the email provider rate limit during launch day.
Ada: Marcus, can you check the limits and request an increase if needed? By the 12th please.
Marcus: Yes, I'll check the limits and file the request by the 12th.
Ada: Let's also keep the launch announcement draft in the shared doc.
Priya: I'll start that draft after the pricing review.
Ada: Fine, no date needed for that one, just before launch.
Max: Do we need anything from design?
Ada: Not for v2. Design is on the dashboard rework.
Marcus: Then I think we're clear. Anything else?
Ada: That's it. Thanks everyone, talk Monday.
`

export const MESSY_SAMPLE = `Ada: Alright, quick sync on the billing revamp and the SOC 2 audit. Max, you start.
Max: Billing migration is half done. The invoices export still fails for EU customers.
Ada: Is that blocking the audit evidence?
Max: Partly. Marcus, can you draft the onboarding checklist for the audit evidence?
Marcus: Yeah I can draft the onboarding checklist, probably by Friday.
Ada: Hm, wait, we already had someone on that checklist, didn't we?
Max: I think Dana started it last week, not sure it went anywhere.
Priya: I can take the data retention policy review, I'll have it done by Friday.
Ada: Actually Priya, legal needs that review by Monday at the latest.
Priya: Oh. Then Monday it is, but I wouldn't promise before that.
Marcus: Someone should fix the EU invoice export before the audit window.
Ada: Yes, someone needs to look at that.
Max: Maybe we should move the audit evidence into the shared drive instead of tickets?
Ada: Interesting, but let's not decide that now.
Priya: Does anyone know who the auditor contact is on our side?
Max: No idea, I thought Dana had it.
Ada: Dana isn't here. Unresolved for now.
Marcus: Also, should we migrate the old customers to the new plan before or after the audit?
Ada: Good question. We need pricing input and Sam is out, so parking it.
Max: I'll update the audit tracker with the new evidence links tomorrow.
Ada: Great. And Priya, can you also send the retention summary to the auditors?
Priya: Sure, I'll send the summary once the review is done.
Marcus: Maybe we could automate the evidence collection with a script.
Ada: That would be nice to have, but not for this quarter.
Max: Decision then: we keep evidence in tickets for this audit and revisit in Q3.
Ada: Yes. Decision: evidence stays in tickets until Q3.
Marcus: What about the Priya on the finance team, should she get the invoice export fix?
Ada: Which Priya? Never mind, let's keep that in the notes.
Max: We should probably also tell customers about the export bug.
Ada: Possibly. Let's see how bad it gets first.
Marcus: I'll write up the root cause of the invoice export failure when I'm back from the offsite.
Ada: Fine. Max, please send the audit scope doc to Dana.
Max: Okay, I'll send it over.
Ada: Anything else? No? Good. We'll regroup next week.
`
