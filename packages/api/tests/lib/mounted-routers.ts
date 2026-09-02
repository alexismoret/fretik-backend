import { accountRoutes } from "../../src/handlers/account";
import { aiMemoryRoutes } from "../../src/handlers/ai-memory";
import { approvalsRoutes } from "../../src/handlers/approvals";
import { chatbotContextRoutes } from "../../src/handlers/chatbot-context";
import { collectionRecordRoutes } from "../../src/handlers/collection-records";
import { collectionSharingRoutes } from "../../src/handlers/collection-sharing";
import { collectionRoutes } from "../../src/handlers/collections";
import { conversationRoutes } from "../../src/handlers/conversations";
import { dashboardRoutes } from "../../src/handlers/dashboard";
import { desktopReleaseRoutes } from "../../src/handlers/desktop-releases";
import { documentRoutes } from "../../src/handlers/documents";
import { externalAppsRoutes } from "../../src/handlers/external-apps";
import { sandboxRoutes } from "../../src/handlers/external-apps/sandbox-exec";
import { fieldDefinitionRoutes } from "../../src/handlers/field-definitions";
import { folderRoutes } from "../../src/handlers/folders";
import { invitationRoutes } from "../../src/handlers/invitations";
import { linkTypeRoutes } from "../../src/handlers/link-types";
import { linkRoutes } from "../../src/handlers/links";
import { organizationRoutes } from "../../src/handlers/organization";
import { pageRoutes } from "../../src/handlers/pages";
import { pinRoutes } from "../../src/handlers/pins";
import { publicFormRoutes } from "../../src/handlers/public-forms";
import { publicPageRoutes } from "../../src/handlers/public-pages";
import { signupAccessRoutes } from "../../src/handlers/signup-access";
import { skillsRoutes } from "../../src/handlers/skills";
import { superAdminRoutes } from "../../src/handlers/super-admins";
import { teamSettingsRoutes } from "../../src/handlers/team-settings";
import { toolPoliciesRoutes } from "../../src/handlers/tool-policies";
import { workflowRoutes } from "../../src/handlers/workflows";

/**
 * Every router `src/index.ts` mounts, keyed by its mount path.
 *
 * A module of its own so a test can pull the whole set through ONE dynamic
 * import, after installing its doubles. Reaching the handlers through static
 * imports in the test file would evaluate them — and everything they pull in —
 * before the test body runs, and the doubles would arrive too late.
 *
 * `src/index.ts` itself is deliberately not imported: it applies migrations at
 * module load, which is the one thing a test may never do.
 */

/**
 * The slice of a Hono app a probe needs. Structural, so every router fits
 * whatever `Variables` its own generic carries.
 *
 * `request()` is typed as possibly synchronous — Hono returns a `Response`
 * directly when no handler in the chain is async — so the caller awaits it.
 */
export interface Probeable {
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
}

export const MOUNTED_ROUTERS: Record<string, Probeable> = {
  "/account": accountRoutes,
  "/ai-memory": aiMemoryRoutes,
  "/approvals": approvalsRoutes,
  "/chatbot-context": chatbotContextRoutes,
  "/collection-records": collectionRecordRoutes,
  "/collection-sharing": collectionSharingRoutes,
  "/collections": collectionRoutes,
  "/conversation": conversationRoutes,
  "/dashboard": dashboardRoutes,
  "/desktop-releases": desktopReleaseRoutes,
  "/document": documentRoutes,
  "/external-apps": externalAppsRoutes,
  "/field-definitions": fieldDefinitionRoutes,
  "/folder": folderRoutes,
  "/forms": publicFormRoutes,
  "/invitations": invitationRoutes,
  "/link-types": linkTypeRoutes,
  "/links": linkRoutes,
  "/organization": organizationRoutes,
  "/p": publicPageRoutes,
  "/pages": pageRoutes,
  "/pins": pinRoutes,
  "/sandbox": sandboxRoutes,
  "/signup-access": signupAccessRoutes,
  "/skills": skillsRoutes,
  "/super-admins": superAdminRoutes,
  "/team-settings": teamSettingsRoutes,
  "/tool-policies": toolPoliciesRoutes,
  "/workflows": workflowRoutes,
};
