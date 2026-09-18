/**
 * Everything the demo workspace is made of, as data.
 *
 * Kept apart from `seed-demo-workspace.ts` because the two are reviewed for
 * different things: that file is plumbing, this one is copy that ends up in
 * screenshots shipped to every customer. It should read like a pull request
 * for marketing material, because that is what it is.
 *
 * ## The rule every line here follows
 *
 * Nothing names an industry. No freight, no customs, no legal, no medical —
 * the root `CLAUDE.md` rule about keeping the core industry-agnostic applies
 * harder to an image than to a string, because an image is not translated,
 * not searched, and not reviewed twice.
 *
 * What is left is the work every office does: a board update, a vendor
 * comparison, an onboarding checklist, expiring contracts, an expense sheet.
 * A reader in any sector should see their own week in it.
 *
 * Company names are invented and intentionally bland. Any resemblance to a
 * real company is the price of inventing plausible names; none of them is a
 * customer, and none carries a real person's details.
 */
import type { ChatSuggestionKind } from "../db/schema";

/** The sign-in for the demo account. Disposable databases only — the seeding
 * script refuses anything else, which is what makes a known password safe. */
export const DEMO_PASSWORD = "FretikDemo2026!";

export const DEMO_ORG = {
  name: "Northwind",
  /** Stable: the seeding script finds the workspace by this, not by name. */
  slug: "northwind-demo",
};

export const DEMO_TEAM_NAME = "Operations";

/**
 * Two people, not one. A workspace with a single member cannot show a
 * conversation with a colleague in it, an assignee on a task, or the fact that
 * a pin is personal — and those are exactly the things a screenshot is for.
 * The first is the owner, and the account the captures are taken from.
 */
export const DEMO_USERS = [
  { name: "Jordan Ellis", email: "demo@fretik.com" },
  { name: "Sam Okafor", email: "demo.teammate@fretik.com" },
];

/** `YYYY-MM-DD`, n days from today — so a seeded due date never goes stale. */
const inDays = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

export interface DemoRecordGroup {
  collectionKey: string;
  rows: (assigneeIds: string[]) => Record<string, unknown>[];
}

export const DEMO_RECORDS: DemoRecordGroup[] = [
  {
    collectionKey: "company",
    rows: () => [
      { name: "Vertex Analytics" },
      { name: "Copperleaf Media" },
      { name: "Lakeside Group" },
      { name: "Harbor & Finch" },
      { name: "Northgate Partners" },
      { name: "Quill & Co." },
    ],
  },
  {
    collectionKey: "task",
    rows: (assigneeIds) => {
      const [owner, teammate] = assigneeIds;
      return [
        {
          title: "Send the Q3 board pack",
          status: "in_progress",
          assignee: owner,
          progress: 70,
          due_date: inDays(3),
        },
        {
          title: "Collect the last two vendor quotes",
          status: "in_progress",
          assignee: teammate ?? owner,
          progress: 40,
          due_date: inDays(5),
        },
        {
          title: "Renew the Harbor & Finch contract",
          status: "todo",
          assignee: owner,
          progress: 0,
          due_date: inDays(12),
        },
        {
          title: "Write the new-hire onboarding checklist",
          status: "in_progress",
          assignee: teammate ?? owner,
          progress: 55,
          due_date: inDays(8),
        },
        {
          title: "Reconcile September expenses",
          status: "todo",
          assignee: owner,
          progress: 0,
          due_date: inDays(-2),
        },
        {
          title: "Merge the duplicate company records",
          status: "todo",
          assignee: teammate ?? owner,
          progress: 0,
          due_date: inDays(9),
        },
        {
          title: "Answer the remaining RFP questions",
          status: "done",
          assignee: owner,
          progress: 100,
          due_date: inDays(-6),
        },
        {
          title: "Refresh the partner review deck",
          status: "done",
          assignee: teammate ?? owner,
          progress: 100,
          due_date: inDays(-9),
        },
      ];
    },
  },
  {
    collectionKey: "note",
    rows: () => [
      {
        title: "Q3 priorities",
        content:
          "Three things, in order: close the two open vendor decisions, get onboarding down to a single day, and stop reconciling expenses by hand.\n\nEverything else waits for Q4.",
      },
      {
        title: "Vendor shortlist — where we landed",
        content:
          "Vertex is stronger on reporting, Copperleaf on support response times.\n\nOpen question: whether we need the reporting at all before the headcount doubles.",
      },
      {
        title: "Onboarding — what new joiners actually ask",
        content:
          "Same four questions every time:\n\n1. Where do I find last quarter's numbers?\n2. Who approves an expense?\n3. Which tools do I need on day one?\n4. Who is my buddy for the first week?",
      },
      {
        title: "Partner review — notes from the last one",
        content:
          "They want a shorter deck and the numbers earlier. Cut the roadmap section to one slide and open on the renewal rate.",
      },
    ],
  },
];

export interface DemoConversation {
  title: string;
  /** Drives `updated_at`, so this is the sidebar's ordering. */
  daysAgo: number;
  /** Set to pin it for the demo reader; the value orders the pinned list. */
  pinnedDaysAgo?: number;
  ask: string;
  answer: string;
}

/**
 * The transcript behind the sidebar.
 *
 * Every conversation carries a real exchange rather than a title alone: the
 * sidebar screenshot only needs the titles, but the next changelog will open
 * one of these, and an empty conversation is an empty screenshot.
 *
 * "How the main project tools present their pricing" is the one written for
 * the source cards. Its answer makes no claim you cannot check by opening the
 * three pages it cites — the pages are real, and what the answer says about
 * them (a free tier, paid automation, seat minimums worth reading) is what
 * they say about themselves. A seeded answer is still an answer somebody
 * reads; inventing findings for a screenshot would be inventing findings.
 */
export const DEMO_CONVERSATIONS: DemoConversation[] = [
  {
    title: "Q3 board update",
    daysAgo: 0,
    pinnedDaysAgo: 6,
    ask: "Draft the Q3 board update from this quarter's notes and tasks. One page, numbers first.",
    answer:
      "Here is a one-page draft, numbers first.\n\n**Where the quarter landed**\n\nThe three Q3 priorities were vendor decisions, onboarding time and expense reconciliation. Two of the three are closed; expense reconciliation slipped and is the one thing worth a line of explanation to the board.\n\n**What I would put on the page**\n\n1. Renewal rate and headcount, in that order — the last review asked for the numbers earlier.\n2. The vendor decision and what it changes next quarter.\n3. Onboarding: down to a single day, with the checklist as the evidence.\n4. One slide on what slipped, and the date it closes.\n\nTell me which of the four you want expanded and I will write the full page.",
  },
  {
    title: "Vendor comparison: Vertex and Copperleaf",
    daysAgo: 1,
    pinnedDaysAgo: 3,
    ask: "Compare the two vendor proposals and tell me which one you would pick.",
    answer:
      "The two proposals are close on price and far apart on everything else.\n\n**Vertex** is the stronger reporting story: scheduled exports, a dashboard per team, and the numbers your board asks for without anyone assembling them by hand. The support commitment is next business day.\n\n**Copperleaf** answers in under two hours and has a named contact. Reporting is an export you build yourself.\n\n**What I would pick, and why.** Copperleaf — but only because your own note says the reporting question does not bite until headcount doubles. If that happens inside the contract term you will be paying for the migration you avoided today, so I would ask Copperleaf for a written reporting roadmap before signing.",
  },
  {
    title: "How the main project tools present their pricing",
    daysAgo: 1,
    ask: "Compare how the main project management tools present their pricing tiers.",
    answer:
      'All three lead with a free tier and put automation, dashboards and admin controls behind the paid ones. The difference is where each draws that line, not the headline price.\n\nTwo things to check before comparing the numbers themselves:\n\n1. **The seat minimum.** Some plans bill a floor whether or not you fill it, which changes the real cost of a small team more than the per-seat price does.\n2. **How guests are counted.** A tool that bills guests like members is a different product once you work with people outside the company.\n\nThe three pricing pages, so you can read them side by side:\n\n::link-cards\n:::link-card{url="https://asana.com/pricing" title="Asana pricing" site="Asana"}\nFree, then two paid tiers. Automation rules and reporting sit above the free plan.\n:::\n:::link-card{url="https://www.atlassian.com/software/jira/pricing" title="Jira pricing" site="Atlassian"}\nFree up to a team size, then per-seat. Watch the change from per-user to a tiered price as the team grows.\n:::\n:::link-card{url="https://monday.com/pricing" title="monday.com pricing and plans" site="monday.com"}\nPriced in seat blocks rather than per seat — the tier you need may cost less than the seats you use.\n:::\n::\n\nIf you tell me the team size and whether guests are in scope, I will put the three side by side as a table.',
  },
  {
    title: "Summary of last week's customer calls",
    daysAgo: 2,
    ask: "Summarize last week's customer calls. What came up more than once?",
    answer:
      "Four calls, and three things came up in at least two of them.\n\n**Reporting turnaround.** Two customers assemble the same monthly numbers by hand and both asked whether it could be scheduled.\n\n**Onboarding a new colleague.** Raised on three calls, always the same way: the first week works, the second is where people get stuck.\n\n**Approvals.** One customer wants an approval step before anything leaves the workspace; another said the opposite, that approvals are what slowed their last tool down.\n\nThe first two are worth a follow-up this week. The third is a preference, not a gap.",
  },
  {
    title: "Onboarding checklist for new hires",
    daysAgo: 3,
    ask: "Write an onboarding checklist for a new joiner that fits on one page.",
    answer:
      "One page, ordered by when it actually matters.\n\n**Before day one**\n\n- Accounts created and added to the team\n- Buddy named, and told they are the buddy\n- First-week calendar sent\n\n**Day one**\n\n- Where last quarter's numbers live\n- Who approves an expense, and up to what amount\n- The four tools needed today, not the twelve that exist\n\n**First week**\n\n- One real task, finished end to end\n- A thirty-minute walkthrough of the last board update\n- Buddy check-in on Friday\n\nYour own note says the same four questions come up every time — all four are answered on day one here, which is the point.",
  },
  {
    title: "Contracts expiring before December",
    daysAgo: 4,
    ask: "Which of our contracts expire before December, and which ones renew automatically?",
    answer:
      "Three expire before December.\n\n**Harbor & Finch** — expires first, and it is the one with an automatic renewal clause. Notice has to be given thirty days ahead, so the decision date is earlier than the expiry date.\n\n**Northgate Partners** — expires in November, no automatic renewal. Nothing happens if nobody acts, which is its own risk.\n\n**Quill & Co.** — expires in late November and renews automatically for twelve months.\n\nThe two automatic renewals are the ones worth a calendar entry: doing nothing is a decision in both.",
  },
  {
    title: "Monthly report from the expense sheet",
    daysAgo: 5,
    ask: "Turn the expense spreadsheet into a monthly report I can send without editing it.",
    answer:
      "Here is the shape I would send.\n\n**Headline.** Total against budget, and the one line that moved most since last month.\n\n**By category.** Five rows, not fifteen — everything under two percent goes into Other.\n\n**What changed.** Two sentences on the largest movement, with the reason rather than the number repeated.\n\n**What is unreconciled.** Named, with a date, so it does not quietly become next month's problem.\n\nI can generate this every month from the same sheet. Say the word and I will set it up so it lands on the first working day.",
  },
  {
    title: "Duplicate companies to merge",
    daysAgo: 6,
    ask: "Find the duplicate company records and tell me which ones to merge.",
    answer:
      'Three pairs look like the same company twice.\n\nTwo of them are spelling variants — an ampersand on one record and the word "and" on the other. Those are safe to merge, keeping the record with the longer history.\n\nThe third is less obvious: two records with different addresses that share a contact. That is either one company that moved or two sites of the same group, and merging the wrong one loses an address nobody will notice is gone.\n\nI would merge the first two now and leave the third until someone confirms it.',
  },
  {
    title: "Talking points for the partner review",
    daysAgo: 8,
    ask: "Prepare talking points for the partner review next week.",
    answer:
      "Five points, in the order the last review asked for.\n\n1. **Renewal rate first.** Your notes say they want the numbers earlier; opening on the renewal rate does that in one slide.\n2. **What changed since last time** — two sentences, no roadmap.\n3. **The vendor decision** and what it means for them.\n4. **One ask.** Reviews without an ask turn into status updates.\n5. **Roadmap, one slide.** They asked for shorter, and this is the section that grows.\n\nI have kept the deck to what they said they wanted. If you want the roadmap back at full length, tell me and I will expand it.",
  },
  {
    title: "Answers to the RFP questionnaire",
    daysAgo: 10,
    ask: "Draft answers to the open questions in the RFP questionnaire, using our previous responses as a guide.",
    answer:
      "I have drafted the four open ones in the same voice as your previous responses.\n\nTwo were straightforward — the answers from the last questionnaire still hold, with the dates updated.\n\nThe third asks about data location, and your previous answer was vaguer than this questionnaire allows. I have written a direct version; it needs someone to confirm it before it goes out.\n\nThe fourth asks for a reference customer. I cannot draft that one for you — it is a name and a permission, not a sentence.",
  },
  {
    title: "Support ticket volume by week",
    daysAgo: 12,
    ask: "Show me support ticket volume by week and tell me whether the trend is real.",
    answer:
      "Volume is up about a fifth over six weeks, but I would not call it a trend yet.\n\nTwo of the six weeks carry most of the increase, and both follow a release. Strip those two and the line is flat.\n\nWhat would make it a trend is the third week after a release staying high — that is the point where new tickets stop being about the change and start being about the product. Worth watching for two more weeks before anyone staffs for it.",
  },
  {
    title: "Rewrite of the pricing page intro",
    daysAgo: 15,
    ask: "Rewrite the intro on our pricing page. It is too long and says nothing.",
    answer:
      "It is long because it explains the pricing model before saying what the product does. Readers who need that explanation have already left.\n\nHere is a shorter version:\n\n> Every plan includes the whole product. What changes is how many people use it and how much you keep.\n>\n> Start free. Move up when your team does.\n\nThat is two sentences instead of a paragraph, and it answers the question people actually arrive with. If legal needs the model spelled out, it belongs under the table rather than above it.",
  },
];

export interface DemoSuggestion {
  kind: ChatSuggestionKind;
  label: string;
  prompt: string;
  reason: string;
}

/**
 * One suggestion per kind, which is what the generator is told to aim for:
 * six slots spent on six different things rather than six follow-ups. Each
 * reason points at something that is genuinely in the seeded workspace, so the
 * screen holds together if a reader reads it closely.
 */
export const DEMO_SUGGESTIONS: DemoSuggestion[] = [
  {
    kind: "pending",
    label: "Reconcile September expenses",
    prompt:
      "Reconcile the September expenses and list anything that does not match, with the amount and the date.",
    reason: "This task passed its due date two days ago.",
  },
  {
    kind: "follow_up",
    label: "Close the vendor decision",
    prompt:
      "Write the recommendation for the Vertex and Copperleaf comparison, including what to ask for before signing.",
    reason: "You compared the two proposals but never wrote the decision.",
  },
  {
    kind: "periodic",
    label: "Draft this month's report",
    prompt:
      "Draft this month's report from the expense sheet, in the format we used last month.",
    reason: "You have sent one on the first working day of each month.",
  },
  {
    kind: "insight",
    label: "Two contracts renew on their own",
    prompt:
      "List the contracts that renew automatically before December, with the date notice has to be given.",
    reason: "Doing nothing renews both of them for another year.",
  },
  {
    kind: "capability",
    label: "Turn the expense sheet into a page",
    prompt:
      "Build a page that charts monthly expenses by category, so I can stop assembling the report by hand.",
    reason: "Your team has never built a page from this spreadsheet.",
  },
];
