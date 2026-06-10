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
    folders: r.many.folders(),
    labels: r.many.labels(),
    documents: r.many.documents(),
    entities: r.many.entities(),
    activityLogs: r.many.activityLogs(),
    webhooks: r.many.webhooks(),
    usageMetrics: r.many.usageMetrics(),
    aiConversations: r.many.aiConversations(),
    aiVectors: r.many.aiVectors(),
    aiContextProfiles: r.many.aiContextProfiles(),
    aiMemories: r.many.aiMemories(),
    aiMemoryHistory: r.many.aiMemoryHistory(),
    fieldDefinitions: r.many.fieldDefinitions(),
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

  labels: {
    team: r.one.team({
      from: r.labels.teamId,
      to: r.team.id,
    }),
    documentLabels: r.many.documentLabels(),
    // Many-to-many through documentLabels
    documents: r.many.documents({
      from: r.labels.id.through(r.documentLabels.labelId),
      to: r.documents.id.through(r.documentLabels.documentId),
    }),
  },

  documentLabels: {
    document: r.one.documents({
      from: r.documentLabels.documentId,
      to: r.documents.id,
    }),
    label: r.one.labels({
      from: r.documentLabels.labelId,
      to: r.labels.id,
    }),
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
    documentLabels: r.many.documentLabels(),
    documentEntities: r.many.documentEntities(),
    fieldValues: r.many.documentFieldValues(),
    // Many-to-many through documentEntities
    entities: r.many.entities({
      from: r.documents.id.through(r.documentEntities.documentId),
      to: r.entities.id.through(r.documentEntities.entityId),
    }),
    // Many-to-many through documentLabels
    labels: r.many.labels({
      from: r.documents.id.through(r.documentLabels.documentId),
      to: r.labels.id.through(r.documentLabels.labelId),
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
  },

  documentFieldValues: {
    document: r.one.documents({
      from: r.documentFieldValues.documentId,
      to: r.documents.id,
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
  // Entities Relations
  // ============================================================================

  entities: {
    team: r.one.team({
      from: r.entities.teamId,
      to: r.team.id,
    }),
    documentEntities: r.many.documentEntities(),
    // Many-to-many through documentEntities
    documents: r.many.documents({
      from: r.entities.id.through(r.documentEntities.entityId),
      to: r.documents.id.through(r.documentEntities.documentId),
    }),
  },

  documentEntities: {
    document: r.one.documents({
      from: r.documentEntities.documentId,
      to: r.documents.id,
    }),
    entity: r.one.entities({
      from: r.documentEntities.entityId,
      to: r.entities.id,
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
}));
