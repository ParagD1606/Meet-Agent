# Slack test script: theInterview Room

Run this yourself in Slack. Replace `@A`, `@B`, `@C` with three real teammates (or three of your accounts).
Post each numbered line as its own message. "Expect" says what Pixel should do or answer.

## 0. Setup (once)
1. Paste `docs/slack-app-manifest.yaml` into Slack app settings and **reinstall**.
2. Create **#pixel-test** (public) and **#pixel-private** (private). In each: `/invite @Pixel`. Pixel posts a one-time "I learn from this channel" notice.
3. Console, Pixel page: switch on Digest, Nudges, Deadlines, Standup, Risks for #pixel-test.
4. Upload `docs/test-pack/theinterviewroom-handbook.md` into #pixel-test.
5. Memory updates after 5 minutes of quiet or 20 messages. Posting section 1 below gives you well over 20.

## 1. Flood memory (#pixel-test, mix the accounts)
1. theInterview Room is a site where students share real interview experiences for campus placements.
2. Our users are mostly PICT students in Pune preparing for placements.
3. The site has Interviews, Tales, Companies and a Share Experience page.
4. Company pages exist for Barclays, Siemens, BNY Mellon, PhonePe, UPTIQ, Mastercard and ZS Associates.
5. We filter stories by company, batch year and department.
6. Tales is coming soon: hackathon nights, shipped projects, internships and open source.
7. The newsletter goes out on the first Sunday of every month.
8. Every new story gets moderated within 48 hours before going live.
9. Stories must not contain confidential questions that break an NDA.
10. @A owns the story moderation process.
11. @B owns the frontend and the feed page.
12. @C owns the newsletter and the Instagram page.
13. Decision: we ship releases on Fridays behind a feature flag.
14. Decision: the Tales section launches in December.
15. The weekly sync is Monday at 8 pm in this channel.
16. The Rounds timeline view for company pages ships in November.
17. The batch year 2027 filter ships in October.
18. Contact email for the site is theinterviewroom.in@gmail.com.
19. Mastercard Code for Change Hackathon appears in one of our stories.
20. Barclays Hack-o-Hire 2024 also appears in a story.

Wait a few minutes. Expect: console Memories and Graph show these facts, with people and projects linked.

## 2. Update a fact (replaces the old one)
21. Update: the Tales section launch moved from December to January.
Expect: asking "when does Tales launch?" answers January, and Memories shows December as superseded.

## 3. Things that must NOT be remembered
22. The admin panel password is hunter2hunter2
23. Here is the key xoxb-1234-5678 for the bot
Expect: neither shows up in Memories.

## 4. Tasks (real @mentions)
24. @A please review the pending Barclays story by Friday
25. @B please fix the feed filter bug by next Tuesday
26. @C please schedule the October newsletter by 25th
27. In the thread of #24 as @A: `I'll take this`, later `done`.
28. In the thread of #25 as @C: `I took this instead`.
29. Edit message #26 to say "by 28th". Delete message #25 afterwards.
Expect in console Commitments: owner, assigner, due date, source link. #24 closes, #25 reassigns then drops, #26 shows the 28th.

## 5. Ask Pixel (in channel and by DM)
- `@Pixel who was given the Barclays story review?` Expect @A and a Source link.
- `@Pixel who owns story moderation?` Expect @A.
- `@Pixel who owns the feed page?` Expect @B.
- `@Pixel when does Tales launch?` Expect January.
- `@Pixel what was the Tales launch date in the first plan?` Expect December.
- `@Pixel which companies have pages?` Expect the list.
- `@Pixel what is our refund policy for premium plans?` Expect "I don't have that".
- Follow-up in a thread: `and who owns the newsletter?`
- Click **Resolved** on a good answer, then ask it again. Expect an instant answer from memory.

## 6. Private channel (#pixel-private, only some accounts)
30. Budget plan: we will not hire anyone before March.
31. @B please prepare the confidential budget doc by Monday
Expect: a non-member asking `@Pixel what is the hiring plan?` in #pixel-test gets "I don't have that". `@Pixel who has the budget doc task?` from a non-member also gets nothing. A member sees the answer.

## 7. Slash commands
- `/remember Our colours are navy and white`
- `/whatdoyouknow Tales`
- `/forget navy` then confirm
- `/brain-tasks` (use Done and Drop)
- `/brain-followups`, then `/brain-followups digest on 09:00`
- As admin: `/brain-review`, `/brain-pause` (post a message, nothing learned), `/brain-resume`

## 8. Follow-ups and routing
- DM Pixel: `remind me tomorrow at 10 to check the Mastercard story`
- `follow up with @B about the feed filter in 2 days`. Expect a confirm card before @B is messaged.
- `@Pixel who handles our domain renewal?` Expect an offer to ask the likely owner, with a consent card.

## 9. Meetings
- Start a **huddle with AI notes** in #pixel-test. Say: "Decision: Tales launches in January. @A will write the Tales announcement by Friday." End it.
- Console Meeting notes, click **Sync**. Expect the huddle, its summary and tasks, and a task DM to @A.

## 10. Console checks
- Memories and Graph: facts with types and dates, entity links, superseded history.
- Core memory: pick #pixel-test, press **Generate from Slack**. Then the **You** tab.
- Commitments, Review queue (approve one), Usage (Cost), Pixel (change tone, save, chat again).

## 11. Time-based (check later)
- Tasks due soon produce nudges. Monday 09:00 digest, weekday 09:05 standup and 09:30 risks, nightly consolidation at 03:17.

## If anything looks wrong
Send me the exact message, the channel, the time and Pixel's reply. I will read the live logs.
