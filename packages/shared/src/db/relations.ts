import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

// Centralized relations definition using Drizzle v2 API
export const relations = defineRelations(schema, (r) => ({
  // ============================================================================
  // Auth Relations (Better-Auth)
  // ============================================================================

  user: {
    accounts: r.many.account(),
    teamMembers: r.many.teamMember(),
    members: r.many.member(),
    sentInvitations: r.many.invitation(),
    // Extended relations
    createdFolders: r.many.folders(),
    uploadedDocuments: r.many.documents(),
    activityLogs: r.many.activityLogs(),
    aiConversations: r.many.aiConversations(),
    uploadedChatFiles: r.many.aiChatFiles(),
    aiContextProfiles: r.many.aiContextProfiles({
      alias: "contextProfileOwner",
    }),
    updatedContextProfiles: r.many.aiContextProfiles({
      alias: "contextProfileUpdater",
    }),
    uploadedContextFiles: r.many.aiContextFiles(),
    contextFileMutes: r.many.aiContextUserFileMutes(),
    contextProfileMutes: r.many.aiContextUserProfileMutes(),
    aiMemories: r.many.aiMemories({ alias: "memoryOwner" }),
    createdMemories: r.many.aiMemories({ alias: "memoryCreator" }),
    modifiedMemories: r.many.aiMemories({ alias: "memoryModifier" }),
    memoryHistoryWrites: r.many.aiMemoryHistory(),
    teamSkillUpdates: r.many.teamSkills(),
    externalAppConnections: r.many.externalAppConnections({
      alias: "externalAppConnectionUser",
    }),
    createdExternalAppConnections: r.many.externalAppConnections({
      alias: "externalAppConnectionCreator",
    }),
    toolApprovalRequests: r.many.toolApprovalRequests({
      alias: "toolApprovalUser",
    }),
    decidedToolApprovals: r.many.toolApprovalRequests({
      alias: "toolApprovalDecider",
    }),
  },

  account: {
    user: r.one.user({
      from: r.account.userId,
      to: r.user.id,
    }),
  },

  organization: {
    teams: r.many.team(),
    members: r.many.member(),
    invitations: r.many.invitation(),
    // Extended relations
    settings: r.one.organizationSettings({
      from: r.organization.id,
      to: r.organizationSettings.organizationId,
    }),
    usageMetrics: r.many.usageMetrics(),
    aiVectors: r.many.aiVectors(),
    aiConversations: r.many.aiConversations(),
    aiContextProfiles: r.many.aiContextProfiles(),
    aiContextFiles: r.many.aiContextFiles(),
    aiMemories: r.many.aiMemories(),
    fieldDefinitions: r.many.fieldDefinitions(),
    objectTypes: r.many.objectTypes(),
    linkTypes: r.many.linkTypes(),
    actionTypes: r.many.actionTypes(),
    objectRecords: r.many.objectRecords(),
    links: r.many.links(),
    domainEvents: r.many.domainEvents(),
    externalAppConnections: r.many.externalAppConnections(),
    toolApprovalRequests: r.many.toolApprovalRequests(),
    fileExtractions: r.many.fileExtractions(),
  },

  team: {
    organization: r.one.organization({
      from: r.team.organizationId,
      to: r.organization.id,
    }),
    teamMembers: r.many.teamMember(),
    // Extended relations
    settings: r.one.teamSettings({
      from: r.team.id,
      to: r.teamSettings.teamId,
    }),
    aiSettings: r.one.teamAiSettings({
      from: r.team.id,
      to: r.teamAiSettings.teamId,
    }),
    folders: r.many.folders(),
    documents: r.many.documents(),
    activityLogs: r.many.activityLogs(),
    webhooks: r.many.webhooks(),
    usageMetrics: r.many.usageMetrics(),
    aiConversations: r.many.aiConversations(),
    aiVectors: r.many.aiVectors(),
    aiContextProfiles: r.many.aiContextProfiles(),
    aiMemories: r.many.aiMemories(),
    aiMemoryHistory: r.many.aiMemoryHistory(),
    fieldDefinitions: r.many.fieldDefinitions(),
    objectTypes: r.many.objectTypes(),
    linkTypes: r.many.linkTypes(),
    actionTypes: r.many.actionTypes(),
    objectRecords: r.many.objectRecords(),
    links: r.many.links(),
    domainEvents: r.many.domainEvents(),
    teamSkills: r.many.teamSkills(),
    ownedSkills: r.many.skills({ alias: "skillTeamOwner" }),
    externalAppConnections: r.many.externalAppConnections(),
    toolApprovalRequests: r.many.toolApprovalRequests(),
  },

  teamMember: {
    team: r.one.team({
      from: r.teamMember.teamId,
      to: r.team.id,
    }),
    user: r.one.user({
      from: r.teamMember.userId,
      to: r.user.id,
    }),
  },

  member: {
    organization: r.one.organization({
      from: r.member.organizationId,
      to: r.organization.id,
    }),
    user: r.one.user({
      from: r.member.userId,
      to: r.user.id,
    }),
  },

  invitation: {
    organization: r.one.organization({
      from: r.invitation.organizationId,
      to: r.organization.id,
    }),
    inviter: r.one.user({
      from: r.invitation.inviterId,
      to: r.user.id,
    }),
  },

  // ============================================================================
  // Organization Extensions Relations
  // ============================================================================

  organizationSettings: {
    organization: r.one.organization({
      from: r.organizationSettings.organizationId,
      to: r.organization.id,
    }),
  },

  teamSettings: {
    team: r.one.team({
      from: r.teamSettings.teamId,
      to: r.team.id,
    }),
  },

  teamAiSettings: {
    team: r.one.team({
      from: r.teamAiSettings.teamId,
      to: r.team.id,
    }),
  },

  // ============================================================================
  // Folders Relations
  // ============================================================================

  folders: {
    team: r.one.team({
      from: r.folders.teamId,
      to: r.team.id,
    }),
    parentFolder: r.one.folders({
      from: r.folders.parentFolderId,
      to: r.folders.id,
      alias: "folderHierarchy",
      optional: true,
    }),
    childFolders: r.many.folders({
      alias: "folderHierarchy",
    }),
    createdBy: r.one.user({
      from: r.folders.createdById,
      to: r.user.id,
      optional: true,
    }),
    documents: r.many.documents(),
  },

  // ============================================================================
  // Documents Relations
  // ============================================================================

  documents: {
    team: r.one.team({
      from: r.documents.teamId,
      to: r.team.id,
    }),
    folder: r.one.folders({
      from: r.documents.folderId,
      to: r.folders.id,
      optional: true,
    }),
    uploadedBy: r.one.user({
      from: r.documents.uploadedById,
      to: r.user.id,
      optional: true,
    }),
    properties: r.one.documentProperties({
      from: r.documents.id,
      to: r.documentProperties.documentId,
      optional: true,
    }),
    // The 1:1 mirror of this document in the unified graph (object_records of
    // type `document`). Its `data` holds the extracted custom field values and
    // its outgoing links are the `mentions` edges to referenced records.
    mirrorRecord: r.one.objectRecords({
      from: r.documents.id,
      to: r.objectRecords.documentId,
      optional: true,
    }),
    chatFiles: r.many.aiChatFiles(),
  },

  documentProperties: {
    document: r.one.documents({
      from: r.documentProperties.documentId,
      to: r.documents.id,
    }),
  },

  // ============================================================================
  // Field Definitions Relations (org/team-scoped dynamic document fields)
  // ============================================================================

  fieldDefinitions: {
    organization: r.one.organization({
      from: r.fieldDefinitions.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.fieldDefinitions.teamId,
      to: r.team.id,
      optional: true,
    }),
    objectType: r.one.objectTypes({
      from: r.fieldDefinitions.objectTypeId,
      to: r.objectTypes.id,
    }),
  },

  // ============================================================================
  // Dynamic data system (ontology) — catalog relations
  // ============================================================================

  objectTypes: {
    organization: r.one.organization({
      from: r.objectTypes.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.objectTypes.teamId,
      to: r.team.id,
      optional: true,
    }),
    fieldDefinitions: r.many.fieldDefinitions(),
    actionTypes: r.many.actionTypes(),
    objectRecords: r.many.objectRecords(),
  },

  linkTypes: {
    organization: r.one.organization({
      from: r.linkTypes.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.linkTypes.teamId,
      to: r.team.id,
      optional: true,
    }),
    links: r.many.links(),
  },

  actionTypes: {
    organization: r.one.organization({
      from: r.actionTypes.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.actionTypes.teamId,
      to: r.team.id,
      optional: true,
    }),
    objectType: r.one.objectTypes({
      from: r.actionTypes.objectTypeId,
      to: r.objectTypes.id,
    }),
  },

  objectRecords: {
    organization: r.one.organization({
      from: r.objectRecords.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.objectRecords.teamId,
      to: r.team.id,
    }),
    owner: r.one.user({
      from: r.objectRecords.userId,
      to: r.user.id,
      optional: true,
    }),
    objectType: r.one.objectTypes({
      from: r.objectRecords.objectTypeId,
      to: r.objectTypes.id,
    }),
    document: r.one.documents({
      from: r.objectRecords.documentId,
      to: r.documents.id,
      optional: true,
    }),
    outgoingLinks: r.many.links({ alias: "linkFrom" }),
    incomingLinks: r.many.links({ alias: "linkTo" }),
    eventLinks: r.many.domainEventLinks(),
    shares: r.many.recordShares(),
  },

  links: {
    organization: r.one.organization({
      from: r.links.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.links.teamId,
      to: r.team.id,
    }),
    linkType: r.one.linkTypes({
      from: r.links.linkTypeId,
      to: r.linkTypes.id,
    }),
    fromRecord: r.one.objectRecords({
      from: r.links.fromRecordId,
      to: r.objectRecords.id,
      alias: "linkFrom",
    }),
    toRecord: r.one.objectRecords({
      from: r.links.toRecordId,
      to: r.objectRecords.id,
      alias: "linkTo",
    }),
  },

  domainEvents: {
    organization: r.one.organization({
      from: r.domainEvents.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.domainEvents.teamId,
      to: r.team.id,
    }),
    actor: r.one.user({
      from: r.domainEvents.actorUserId,
      to: r.user.id,
      optional: true,
    }),
    conversation: r.one.aiConversations({
      from: r.domainEvents.conversationId,
      to: r.aiConversations.id,
      optional: true,
    }),
    subjectRecord: r.one.objectRecords({
      from: r.domainEvents.subjectRecordId,
      to: r.objectRecords.id,
      optional: true,
    }),
    eventLinks: r.many.domainEventLinks(),
  },

  domainEventLinks: {
    event: r.one.domainEvents({
      from: r.domainEventLinks.eventId,
      to: r.domainEvents.id,
    }),
    record: r.one.objectRecords({
      from: r.domainEventLinks.recordId,
      to: r.objectRecords.id,
    }),
  },

  aiEpisodes: {
    organization: r.one.organization({
      from: r.aiEpisodes.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.aiEpisodes.teamId,
      to: r.team.id,
    }),
    user: r.one.user({
      from: r.aiEpisodes.userId,
      to: r.user.id,
      optional: true,
    }),
    conversation: r.one.aiConversations({
      from: r.aiEpisodes.conversationId,
      to: r.aiConversations.id,
      optional: true,
    }),
    anchorRecord: r.one.objectRecords({
      from: r.aiEpisodes.anchorRecordId,
      to: r.objectRecords.id,
      optional: true,
    }),
    supersededBy: r.one.aiEpisodes({
      from: r.aiEpisodes.supersededById,
      to: r.aiEpisodes.id,
      optional: true,
    }),
    episodeRecords: r.many.aiEpisodeRecords(),
  },
  aiEpisodeRecords: {
    episode: r.one.aiEpisodes({
      from: r.aiEpisodeRecords.episodeId,
      to: r.aiEpisodes.id,
    }),
    record: r.one.objectRecords({
      from: r.aiEpisodeRecords.recordId,
      to: r.objectRecords.id,
    }),
  },

  objectGrants: {
    organization: r.one.organization({
      from: r.objectGrants.organizationId,
      to: r.organization.id,
    }),
    objectType: r.one.objectTypes({
      from: r.objectGrants.objectTypeId,
      to: r.objectTypes.id,
    }),
    ownerTeam: r.one.team({
      from: r.objectGrants.ownerTeamId,
      to: r.team.id,
      alias: "objectGrantOwnerTeam",
    }),
    granteeTeam: r.one.team({
      from: r.objectGrants.granteeTeamId,
      to: r.team.id,
      alias: "objectGrantGranteeTeam",
      optional: true,
    }),
  },

  recordShares: {
    organization: r.one.organization({
      from: r.recordShares.organizationId,
      to: r.organization.id,
    }),
    record: r.one.objectRecords({
      from: r.recordShares.recordId,
      to: r.objectRecords.id,
    }),
    ownerTeam: r.one.team({
      from: r.recordShares.ownerTeamId,
      to: r.team.id,
      alias: "recordShareOwnerTeam",
    }),
    granteeTeam: r.one.team({
      from: r.recordShares.granteeTeamId,
      to: r.team.id,
      alias: "recordShareGranteeTeam",
      optional: true,
    }),
  },

  // ============================================================================
  // AI Vectors Relations
  // ============================================================================

  aiVectors: {
    team: r.one.team({
      from: r.aiVectors.teamId,
      to: r.team.id,
      optional: true,
    }),
    organization: r.one.organization({
      from: r.aiVectors.organizationId,
      to: r.organization.id,
      optional: true,
    }),
  },

  // ============================================================================
  // Metrics Relations
  // ============================================================================

  usageMetrics: {
    organization: r.one.organization({
      from: r.usageMetrics.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.usageMetrics.teamId,
      to: r.team.id,
      optional: true,
    }),
  },

  activityLogs: {
    team: r.one.team({
      from: r.activityLogs.teamId,
      to: r.team.id,
    }),
    user: r.one.user({
      from: r.activityLogs.userId,
      to: r.user.id,
      optional: true,
    }),
  },

  webhooks: {
    team: r.one.team({
      from: r.webhooks.teamId,
      to: r.team.id,
    }),
  },

  // ============================================================================
  // AI Relations (ai_conversations, ai_messages)
  // ============================================================================

  aiConversations: {
    organization: r.one.organization({
      from: r.aiConversations.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.aiConversations.teamId,
      to: r.team.id,
    }),
    user: r.one.user({
      from: r.aiConversations.userId,
      to: r.user.id,
      optional: true,
    }),
    messages: r.many.aiMessages(),
    members: r.many.aiConversationMembers(),
    chatFiles: r.many.aiChatFiles(),
    triggeredMemoryCreates: r.many.aiMemories({
      alias: "memoryCreatedByConversation",
    }),
    triggeredMemoryModifications: r.many.aiMemories({
      alias: "memoryModifiedByConversation",
    }),
    triggeredMemoryHistory: r.many.aiMemoryHistory({
      alias: "memoryHistoryConversation",
    }),
    toolApprovalRequests: r.many.toolApprovalRequests(),
  },

  aiMessages: {
    conversation: r.one.aiConversations({
      from: r.aiMessages.conversationId,
      to: r.aiConversations.id,
    }),
    author: r.one.user({
      from: r.aiMessages.authorId,
      to: r.user.id,
      optional: true,
    }),
    chatFiles: r.many.aiChatFiles(),
  },

  aiConversationMembers: {
    conversation: r.one.aiConversations({
      from: r.aiConversationMembers.conversationId,
      to: r.aiConversations.id,
    }),
    user: r.one.user({
      from: r.aiConversationMembers.userId,
      to: r.user.id,
    }),
  },

  aiChatFiles: {
    conversation: r.one.aiConversations({
      from: r.aiChatFiles.conversationId,
      to: r.aiConversations.id,
    }),
    document: r.one.documents({
      from: r.aiChatFiles.documentId,
      to: r.documents.id,
      optional: true,
    }),
    message: r.one.aiMessages({
      from: r.aiChatFiles.messageId,
      to: r.aiMessages.id,
      optional: true,
    }),
    uploadedBy: r.one.user({
      from: r.aiChatFiles.uploadedById,
      to: r.user.id,
      optional: true,
    }),
  },

  fileExtractions: {
    organization: r.one.organization({
      from: r.fileExtractions.organizationId,
      to: r.organization.id,
    }),
  },

  // ============================================================================
  // AI Context Relations (Projects-style user + team persistent context)
  // ============================================================================

  aiContextProfiles: {
    organization: r.one.organization({
      from: r.aiContextProfiles.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.aiContextProfiles.teamId,
      to: r.team.id,
      optional: true,
    }),
    user: r.one.user({
      from: r.aiContextProfiles.userId,
      to: r.user.id,
      alias: "contextProfileOwner",
      optional: true,
    }),
    updatedBy: r.one.user({
      from: r.aiContextProfiles.updatedById,
      to: r.user.id,
      alias: "contextProfileUpdater",
      optional: true,
    }),
    files: r.many.aiContextFiles(),
    userMutes: r.many.aiContextUserProfileMutes(),
  },

  aiContextFiles: {
    profile: r.one.aiContextProfiles({
      from: r.aiContextFiles.profileId,
      to: r.aiContextProfiles.id,
    }),
    organization: r.one.organization({
      from: r.aiContextFiles.organizationId,
      to: r.organization.id,
    }),
    uploadedBy: r.one.user({
      from: r.aiContextFiles.uploadedById,
      to: r.user.id,
      optional: true,
    }),
    userMutes: r.many.aiContextUserFileMutes(),
  },

  aiContextUserFileMutes: {
    user: r.one.user({
      from: r.aiContextUserFileMutes.userId,
      to: r.user.id,
    }),
    file: r.one.aiContextFiles({
      from: r.aiContextUserFileMutes.fileId,
      to: r.aiContextFiles.id,
    }),
  },

  aiContextUserProfileMutes: {
    user: r.one.user({
      from: r.aiContextUserProfileMutes.userId,
      to: r.user.id,
    }),
    profile: r.one.aiContextProfiles({
      from: r.aiContextUserProfileMutes.profileId,
      to: r.aiContextProfiles.id,
    }),
  },

  // ============================================================================
  // AI Memory Relations (agent-writable memory store + audit log)
  // ============================================================================

  aiMemories: {
    organization: r.one.organization({
      from: r.aiMemories.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.aiMemories.teamId,
      to: r.team.id,
    }),
    owner: r.one.user({
      from: r.aiMemories.userId,
      to: r.user.id,
      alias: "memoryOwner",
      optional: true,
    }),
    createdBy: r.one.user({
      from: r.aiMemories.createdByUserId,
      to: r.user.id,
      alias: "memoryCreator",
      optional: true,
    }),
    lastModifiedBy: r.one.user({
      from: r.aiMemories.lastModifiedByUserId,
      to: r.user.id,
      alias: "memoryModifier",
      optional: true,
    }),
    createdByConversation: r.one.aiConversations({
      from: r.aiMemories.createdByConversationId,
      to: r.aiConversations.id,
      alias: "memoryCreatedByConversation",
      optional: true,
    }),
    lastModifiedByConversation: r.one.aiConversations({
      from: r.aiMemories.lastModifiedByConversationId,
      to: r.aiConversations.id,
      alias: "memoryModifiedByConversation",
      optional: true,
    }),
    history: r.many.aiMemoryHistory(),
  },

  aiMemoryHistory: {
    memory: r.one.aiMemories({
      from: r.aiMemoryHistory.memoryId,
      to: r.aiMemories.id,
    }),
    team: r.one.team({
      from: r.aiMemoryHistory.teamId,
      to: r.team.id,
    }),
    byUser: r.one.user({
      from: r.aiMemoryHistory.byUserId,
      to: r.user.id,
      optional: true,
    }),
    byConversation: r.one.aiConversations({
      from: r.aiMemoryHistory.byConversationId,
      to: r.aiConversations.id,
      alias: "memoryHistoryConversation",
      optional: true,
    }),
  },

  // ============================================================================
  // Skills Relations
  // ============================================================================

  skills: {
    teamOwner: r.one.team({
      from: r.skills.teamId,
      to: r.team.id,
      alias: "skillTeamOwner",
      optional: true,
    }),
    teamOverrides: r.many.teamSkills(),
  },

  teamSkills: {
    team: r.one.team({
      from: r.teamSkills.teamId,
      to: r.team.id,
    }),
    skill: r.one.skills({
      from: r.teamSkills.skillId,
      to: r.skills.id,
    }),
    updatedBy: r.one.user({
      from: r.teamSkills.updatedById,
      to: r.user.id,
      optional: true,
    }),
  },

  // ============================================================================
  // External Apps Relations (Nango connections + write-action approval gate)
  // ============================================================================

  externalAppConnections: {
    organization: r.one.organization({
      from: r.externalAppConnections.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.externalAppConnections.teamId,
      to: r.team.id,
    }),
    user: r.one.user({
      from: r.externalAppConnections.userId,
      to: r.user.id,
      alias: "externalAppConnectionUser",
      optional: true,
    }),
    createdBy: r.one.user({
      from: r.externalAppConnections.createdByUserId,
      to: r.user.id,
      alias: "externalAppConnectionCreator",
    }),
  },

  toolApprovalRequests: {
    organization: r.one.organization({
      from: r.toolApprovalRequests.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.toolApprovalRequests.teamId,
      to: r.team.id,
    }),
    user: r.one.user({
      from: r.toolApprovalRequests.userId,
      to: r.user.id,
      alias: "toolApprovalUser",
    }),
    decidedBy: r.one.user({
      from: r.toolApprovalRequests.decidedByUserId,
      to: r.user.id,
      alias: "toolApprovalDecider",
      optional: true,
    }),
    conversation: r.one.aiConversations({
      from: r.toolApprovalRequests.conversationId,
      to: r.aiConversations.id,
    }),
  },

  workflows: {
    organization: r.one.organization({
      from: r.workflows.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.workflows.teamId,
      to: r.team.id,
    }),
    user: r.one.user({
      from: r.workflows.userId,
      to: r.user.id,
      alias: "workflowOwner",
      optional: true,
    }),
    createdBy: r.one.user({
      from: r.workflows.createdByUserId,
      to: r.user.id,
      alias: "workflowCreator",
      optional: true,
    }),
    runs: r.many.workflowRuns(),
  },

  workflowRuns: {
    workflow: r.one.workflows({
      from: r.workflowRuns.workflowId,
      to: r.workflows.id,
    }),
    organization: r.one.organization({
      from: r.workflowRuns.organizationId,
      to: r.organization.id,
    }),
    team: r.one.team({
      from: r.workflowRuns.teamId,
      to: r.team.id,
    }),
    actingUser: r.one.user({
      from: r.workflowRuns.actingUserId,
      to: r.user.id,
      alias: "workflowRunActor",
      optional: true,
    }),
    triggeredBy: r.one.user({
      from: r.workflowRuns.triggeredByUserId,
      to: r.user.id,
      alias: "workflowRunTrigger",
      optional: true,
    }),
    conversation: r.one.aiConversations({
      from: r.workflowRuns.conversationId,
      to: r.aiConversations.id,
      optional: true,
    }),
  },
}));
