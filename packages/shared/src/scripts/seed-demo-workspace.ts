/**
 * The workspace every changelog screenshot is taken in.
 *
 *     bun run seed:demo-workspace          # create or top up
 *     bun run seed:demo-workspace --reset  # delete it first, then rebuild
 *
 * ## Why this exists
 *
 * A product update is shipped to every customer at once, and the screenshots
 * in it are the only part nobody proofreads word by word. Shot from a real
 * workspace they carry whatever that workspace happens to hold: the pinned
 * conversation, the collection names, the document titles in the sidebar.
 *
 * Two things make that unacceptable rather than merely untidy.
 *
 *  1. **Positioning.** The root `CLAUDE.md` rule is that the core reads as
 *     industry-agnostic. A single screenshot of a working workspace can put
 *     customs, freight or legal vocabulary in front of every customer, and an
 *     image says it louder than a string ever could.
 *  2. **Other people's data.** A real workspace holds a real company's names,
 *     numbers and half-finished thoughts. None of that is ours to publish.
 *
 * So the captures come from here instead: one workspace, deliberately boring,
 * deliberately generic, and reproducible from this file rather than from
 * whoever set it up last. `CHANGELOG-AUTHORING.md` §2 makes using it a rule.
 *
 * ## Why it is a script and not a fixture someone made once
 *
 * A demo workspace decays. Features land, the shape of a conversation changes,
 * and the thing you shoot in six months is only as good as somebody's memory
 * of what it was for. A committed script means the next capture starts from a
 * known state, the data can be reviewed in a pull request like any other copy,
 * and `--reset` is the answer to "someone typed in it".
 *
 * ## Scope
 *
 * Disposable databases only — no `--target=prod` escape. The account has a
 * known password, which is exactly what must never exist in production, and a
 * demo workspace has no business there in the first place.
 */
import { eq, inArray } from "drizzle-orm";
import db from "../db";
import {
  aiConversationMembers,
  aiConversations,
  aiMessages,
  chatSuggestions,
  member,
  organization,
  organizationSettings,
  signupAllowlist,
  team,
  teamMember,
  user,
} from "../db/schema";
import { auth } from "../lib/auth";
import { assertOperatorTarget } from "../lib/operator-guard";
import { bootstrapTeamWithBotUser } from "../services/auth/bot-user";
import { bulkCreateCollectionRecords } from "../services/collection-records/bulk-create";
import { seedStarterCollections } from "../services/collections/seed-starter-types";
import { seedSystemOntology } from "../services/collections/seed-system-types";
import { applyDocumentFieldTemplate } from "../services/field-definitions/apply-template";
import { duplicateOrgDefsToTeam } from "../services/field-definitions/duplicate-org-to-team";
import {
  DEMO_CONVERSATIONS,
  DEMO_ORG,
  DEMO_PASSWORD,
  DEMO_RECORDS,
  DEMO_SUGGESTIONS,
  DEMO_TEAM_NAME,
  DEMO_USERS,
} from "./demo-workspace-data";

const RESET = Bun.argv.includes("--reset");

/**
 * Better Auth 1.7's single-column uniqueness boundary for a user in a team:
 * base64url(sha256(JSON.stringify([teamId, userId]))).
 *
 * Recomputed here for the same reason `services/auth/bot-user.ts` and
 * `evals/scripts/ensure-write-team.ts` recompute it: these rows are inserted
 * directly rather than through Better Auth's `addTeamMember`, and a NULL key
 * would leave that boundary unenforced for exactly the rows we control.
 */
const membershipKey = async (
  teamId: string,
  userId: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([teamId, userId])),
  );
  return Buffer.from(digest)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/** `daysAgo` before the run, at a plausible hour rather than midnight. */
const daysBefore = (days: number, hour: number): Date => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, (days * 7) % 60, 0, 0);
  return date;
};

/**
 * How old the workspace claims to be.
 *
 * Not decoration. A workspace whose account was created this morning and whose
 * oldest conversation is from a fortnight ago contradicts itself, and the
 * contradiction is visible: the sidebar groups conversations by age. It also
 * decides what the reader is shown — the announcement modal only fires for an
 * update published after the account existed, so an account created today
 * would never see the very update its screenshots are being taken for.
 */
const WORKSPACE_AGE_DAYS = 60;

/**
 * Delete the workspace, users included.
 *
 * `organization` cascades to everything scoped to it, but `user` has no
 * foreign key to it — Better Auth owns that table — so the accounts have to go
 * explicitly, and last: the org's `member` rows reference them.
 */
const wipe = async (): Promise<void> => {
  const org = await db.query.organization.findFirst({
    where: { slug: DEMO_ORG.slug },
    columns: { id: true },
  });

  // The per-team bot users are org members too, and they outlive the cascade
  // for the same reason the humans do.
  const botUserIds = org
    ? (
        await db.query.member.findMany({
          where: { organizationId: org.id, role: "bot" },
          columns: { userId: true },
        })
      ).map((row) => row.userId)
    : [];

  if (org) {
    await db.delete(organization).where(eq(organization.id, org.id));
  }

  const emails = DEMO_USERS.map((demo) => demo.email);
  await db.delete(user).where(inArray(user.email, emails));
  if (botUserIds.length > 0) {
    await db.delete(user).where(inArray(user.id, botUserIds));
  }
  console.log(`  wiped ${org ? "1 organization" : "no organization"}`);
};

/**
 * The account, created through Better Auth so the password hash, the `account`
 * row and its `issuer` are whatever the running version says they are — not
 * whatever this script believed when it was written.
 *
 * Sign-up is gated to allowlisted emails during the closed beta, so the
 * allowlist row goes in first; `emailVerified` is then set directly, because
 * `requireEmailVerification` would otherwise leave an account nobody can log
 * into and the verification mail has no inbox to land in.
 */
const ensureUser = async (demo: {
  name: string;
  email: string;
}): Promise<string> => {
  const existing = await db.query.user.findFirst({
    where: { email: demo.email },
    columns: { id: true },
  });
  if (existing) return existing.id;

  await db
    .insert(signupAllowlist)
    .values({ email: demo.email, note: "changelog demo workspace" })
    .onConflictDoNothing();

  const result = await auth.api.signUpEmail({
    body: { name: demo.name, email: demo.email, password: DEMO_PASSWORD },
  });

  await db
    .update(user)
    .set({
      emailVerified: true,
      language: "en",
      createdAt: daysBefore(WORKSPACE_AGE_DAYS, 10),
    })
    .where(eq(user.id, result.user.id));

  return result.user.id;
};

/**
 * The organization, plus everything Better Auth's `afterCreateOrganization`
 * hook does when one is created through the API. Called in the hook's own
 * order: the settings row, the required `document` type, the deletable starter
 * ontology, then the org-scope document fields that the new team inherits.
 */
const ensureOrganization = async (): Promise<string> => {
  const existing = await db.query.organization.findFirst({
    where: { slug: DEMO_ORG.slug },
    columns: { id: true },
  });
  if (existing) return existing.id;

  const [row] = await db
    .insert(organization)
    .values({
      name: DEMO_ORG.name,
      slug: DEMO_ORG.slug,
      createdAt: daysBefore(WORKSPACE_AGE_DAYS, 10),
    })
    .returning({ id: organization.id });
  if (!row) throw new Error("failed to insert the demo organization");

  await db
    .insert(organizationSettings)
    .values({ organizationId: row.id })
    .onConflictDoNothing();
  await seedSystemOntology(row.id);
  await seedStarterCollections(row.id);
  await applyDocumentFieldTemplate({
    organizationId: row.id,
    teamId: null,
    templateKey: "default",
    mode: "replace",
  });

  return row.id;
};

/** The team, plus what `afterCreateTeam` does: a bot user and the field defs. */
const ensureTeam = async (organizationId: string): Promise<string> => {
  const existing = await db.query.team.findFirst({
    where: { organizationId, name: DEMO_TEAM_NAME },
    columns: { id: true },
  });

  const teamId = await (async (): Promise<string> => {
    if (existing) return existing.id;
    const [row] = await db
      .insert(team)
      .values({
        name: DEMO_TEAM_NAME,
        organizationId,
        createdAt: daysBefore(WORKSPACE_AGE_DAYS, 10),
      })
      .returning({ id: team.id });
    if (!row) throw new Error("failed to insert the demo team");
    return row.id;
  })();

  await bootstrapTeamWithBotUser({ teamId, organizationId });
  await duplicateOrgDefsToTeam({ organizationId, teamId });
  return teamId;
};

const seatUser = async (input: {
  userId: string;
  organizationId: string;
  teamId: string;
  role: string;
}): Promise<void> => {
  await db
    .insert(member)
    .values({
      organizationId: input.organizationId,
      userId: input.userId,
      role: input.role,
      createdAt: new Date(),
    })
    .onConflictDoNothing();

  const seated = await db.query.teamMember.findFirst({
    where: { teamId: input.teamId, userId: input.userId },
    columns: { id: true },
  });
  if (seated) return;

  await db
    .insert(teamMember)
    .values({
      teamId: input.teamId,
      userId: input.userId,
      membershipKey: await membershipKey(input.teamId, input.userId),
      createdAt: new Date(),
    })
    .onConflictDoNothing();
};

/**
 * Records for the starter collections, through the normal write path so the
 * per-collection tables, the identity columns and the `record.created` journal
 * entries are the same ones a person typing into the UI would produce.
 */
const seedRecords = async (input: {
  organizationId: string;
  teamId: string;
  userId: string;
  assigneeIds: string[];
}): Promise<number> => {
  const teamCollections = await db.query.collections.findMany({
    where: { organizationId: input.organizationId },
    columns: { id: true, key: true },
  });
  const idByKey = new Map(teamCollections.map((row) => [row.key, row.id]));

  let written = 0;
  for (const group of DEMO_RECORDS) {
    const collectionId = idByKey.get(group.collectionKey);
    if (!collectionId) {
      console.warn(`  ! no "${group.collectionKey}" collection — skipped`);
      continue;
    }

    const already = await db.query.collectionRecords.findFirst({
      where: { teamId: input.teamId, collectionId },
      columns: { id: true },
    });
    if (already) continue;

    const result = await bulkCreateCollectionRecords({
      organizationId: input.organizationId,
      teamId: input.teamId,
      userId: input.userId,
      collectionId,
      rows: group.rows(input.assigneeIds).map((data) => ({ data })),
    });
    for (const error of result.errors) {
      console.warn(
        `  ! ${group.collectionKey}[${error.index}]: ${error.error}`,
      );
    }
    written += result.ids.filter((id) => id !== null).length;
  }
  return written;
};

/**
 * The conversations, their transcripts and their pins.
 *
 * Written as rows rather than driven through the chatbot on purpose: a
 * screenshot has to be the same every time it is taken, and a real turn is a
 * live model, a cost, and a different answer on every run. What the screenshot
 * proves — that the sidebar lists them, that a pin floats one to the top, that
 * the prose and the source cards render — is the frontend's job, and the
 * frontend sees no difference between these rows and any others.
 */
const seedConversations = async (input: {
  organizationId: string;
  teamId: string;
  userId: string;
}): Promise<number> => {
  const existing = await db.query.aiConversations.findFirst({
    where: { teamId: input.teamId },
    columns: { id: true },
  });
  if (existing) return 0;

  let written = 0;
  for (const seed of DEMO_CONVERSATIONS) {
    const askedAt = daysBefore(seed.daysAgo, 9);
    const answeredAt = new Date(askedAt.getTime() + 40_000);

    const [conversation] = await db
      .insert(aiConversations)
      .values({
        organizationId: input.organizationId,
        teamId: input.teamId,
        userId: input.userId,
        title: seed.title,
        createdAt: askedAt,
        updatedAt: answeredAt,
      })
      .returning({ id: aiConversations.id });
    if (!conversation) throw new Error(`failed to insert "${seed.title}"`);

    await db.insert(aiMessages).values([
      {
        conversationId: conversation.id,
        authorId: input.userId,
        role: "user",
        parts: [{ type: "text", text: seed.ask }],
        createdAt: askedAt,
      },
      {
        conversationId: conversation.id,
        role: "assistant",
        parts: [{ type: "text", text: seed.answer }],
        createdAt: answeredAt,
      },
    ]);

    await db.insert(aiConversationMembers).values({
      conversationId: conversation.id,
      userId: input.userId,
      role: "owner",
      lastReadAt: answeredAt,
      pinnedAt:
        seed.pinnedDaysAgo === undefined
          ? null
          : daysBefore(seed.pinnedDaysAgo, 11),
      joinedAt: askedAt,
      createdAt: askedAt,
    });

    written += 1;
  }
  return written;
};

/**
 * One batch of chat suggestions for the demo reader.
 *
 * Seeded rather than generated because the generator is an LLM call whose
 * output changes every run, and a screenshot of the home screen has to be
 * stable. The freshness rule (`services/chat-suggestions/freshness.ts`) serves
 * a batch under an hour old without regenerating, so a batch written now is
 * what the screen shows; an older one is still served immediately while a new
 * one is written behind the reader, which is also fine to shoot.
 */
const seedSuggestions = async (input: {
  organizationId: string;
  teamId: string;
  userId: string;
}): Promise<number> => {
  const existing = await db.query.chatSuggestions.findFirst({
    where: { userId: input.userId, teamId: input.teamId, status: "active" },
    columns: { id: true },
  });
  if (existing) return 0;

  const batchId = Bun.randomUUIDv7();
  await db.insert(chatSuggestions).values(
    DEMO_SUGGESTIONS.map((suggestion) => ({
      organizationId: input.organizationId,
      teamId: input.teamId,
      userId: input.userId,
      batchId,
      kind: suggestion.kind,
      label: suggestion.label,
      prompt: suggestion.prompt,
      reason: suggestion.reason,
      inputHash: "seeded-demo-workspace",
      modelKey: "seeded",
    })),
  );
  return DEMO_SUGGESTIONS.length;
};

const run = async (): Promise<void> => {
  const { target, database } = await assertOperatorTarget(Bun.argv);
  if (target !== "dev") {
    console.error(
      `\n  Refusing to seed a demo workspace into "${database}".\n\n` +
        "  This account has a password written in the repository, and a\n" +
        "  workspace made of invented data has no place in production.\n" +
        "  Point DATABASE_URL at a disposable database and re-run.\n",
    );
    process.exit(1);
  }

  if (RESET) {
    console.log("\n  --reset");
    await wipe();
  }

  const organizationId = await ensureOrganization();
  const teamId = await ensureTeam(organizationId);

  const userIds: string[] = [];
  for (const [index, demo] of DEMO_USERS.entries()) {
    const userId = await ensureUser(demo);
    await seatUser({
      userId,
      organizationId,
      teamId,
      role: index === 0 ? "owner" : "member",
    });
    userIds.push(userId);
  }

  const ownerId = userIds[0];
  if (!ownerId) throw new Error("demo workspace needs at least one user");

  await db
    .update(team)
    .set({ memberCount: userIds.length })
    .where(eq(team.id, teamId));

  const records = await seedRecords({
    organizationId,
    teamId,
    userId: ownerId,
    assigneeIds: userIds,
  });
  const conversations = await seedConversations({
    organizationId,
    teamId,
    userId: ownerId,
  });
  const suggestions = await seedSuggestions({
    organizationId,
    teamId,
    userId: ownerId,
  });

  console.log(
    `\n  ${DEMO_ORG.name} — ${DEMO_TEAM_NAME}\n` +
      `    organization  ${organizationId}\n` +
      `    team          ${teamId}\n` +
      `    sign in as    ${DEMO_USERS[0]?.email ?? ""} / ${DEMO_PASSWORD}\n` +
      `    seeded        ${records.toString()} record(s), ${conversations.toString()} conversation(s), ${suggestions.toString()} suggestion(s)\n\n` +
      "  Already-populated sections are left alone; use --reset to rebuild.\n",
  );
};

await run();
process.exit(0);
