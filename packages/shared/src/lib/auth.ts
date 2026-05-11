import { redisStorage } from "@better-auth/redis-storage";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import db from "../db";
import * as schema from "../db/schema";
import { generateOrganizationInvitation } from "../emails/generators";
import { bootstrapTeamWithBotUser } from "../services/auth/bot-user";
import { sendEmail } from "./email";
import { redis } from "./redis";

const appUrl = process.env.APP_URL;
if (!appUrl) {
  throw "Missing APP_URL env";
}

export const auth = betterAuth({
  appName: "fretik",

  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  secondaryStorage: redisStorage({
    client: redis,
  }),
  verification: {
    storeIdentifier: "hashed",
  },

  advanced: {
    database: {
      generateId: () => Bun.randomUUIDv7(),
    },
    cookiePrefix: "fretik-",
  },

  basePath: "/auth",
  trustedOrigins: [appUrl],

  emailAndPassword: {
    enabled: true,
  },

  plugins: [
    organization({
      organizationHooks: {
        afterCreateOrganization: async (data) => {
          await db.insert(schema.organizationSettings).values({
            organizationId: data.organization.id,
          });
        },
        afterCreateTeam: async (data) => {
          await bootstrapTeamWithBotUser({
            teamId: data.team.id,
            organizationId: data.team.organizationId,
          });
        },
      },

      sendInvitationEmail: async (data) => {
        const { subject, html } = await generateOrganizationInvitation({
          invitationId: data.id,
          inviterName: data.inviter.user.name,
          organizationName: data.organization.name,
          role: data.role,
          teamId: data.invitation.teamId,
          expiresAt: data.invitation.expiresAt,
        });

        await sendEmail({
          to: { email: data.email },
          subject,
          html,
        });
      },

      teams: {
        enabled: true,
        maximumTeams: async (data) => {
          const settings = await db.query.organizationSettings.findFirst({
            columns: { maxAgencies: true },
            where: { organizationId: data.organizationId },
          });
          return settings?.maxAgencies ?? 1;
        },
        maximumMembersPerTeam: 50,
        allowRemovingAllTeams: false,
      },
    }),
  ],
});
