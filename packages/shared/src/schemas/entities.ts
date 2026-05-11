import { z } from "zod";
import {
  enrichmentStatusEnum,
  entityRoleEnum,
  entitySourceEnum,
  entityStatusEnum,
  entityTypeEnum,
} from "../db/schema";
import { responseListSchema } from "./common/responses";

// Enum schemas
export const entityStatusSchema = z.enum(entityStatusEnum.enumValues);
export const entityTypeSchema = z.enum(entityTypeEnum.enumValues);
export const entityRoleSchema = z.enum(entityRoleEnum.enumValues);
export const entitySourceSchema = z.enum(entitySourceEnum.enumValues);
export const enrichmentStatusSchema = z.enum(enrichmentStatusEnum.enumValues);

/**
 * Create entity
 */
export const CreateEntitySchema = z.object({
  name: z.string().min(1).max(200),
  type: entityTypeSchema,
  aliases: z.array(z.string().max(200)).default([]),
  notes: z.string().max(2000).nullish(),
});

export type CreateEntityInput = z.infer<typeof CreateEntitySchema>;

/**
 * Update entity
 */
export const UpdateEntitySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: entityTypeSchema.optional(),
  aliases: z.array(z.string().max(200)).optional(),
  notes: z.string().max(2000).nullish(),
  status: z.enum(["confirmed", "rejected"]).optional(),
});

export type UpdateEntityInput = z.infer<typeof UpdateEntitySchema>;

/**
 * Merge entity into another
 */
export const MergeEntitySchema = z.object({
  targetEntityId: z.uuid(),
});

export type MergeEntityInput = z.infer<typeof MergeEntitySchema>;

/**
 * Entity response
 */
export const EntityResponseSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  status: entityStatusSchema,
  type: entityTypeSchema,
  name: z.string(),
  normalizedName: z.string(),
  aliases: z.array(z.string()),
  notes: z.string().nullable(),
  imageS3Key: z.string().nullable(),
  imageUrl: z.string().nullable(),
  website: z.string().nullable(),
  address: z.string().nullable(),
  country: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  enrichmentStatus: enrichmentStatusSchema.nullable(),
  enrichedAt: z.date().nullable(),
  documentCount: z.number().int(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type EntityResponse = z.infer<typeof EntityResponseSchema>;

/**
 * Entity list response
 */
export const EntityListResponseSchema =
  responseListSchema(EntityResponseSchema);

export type EntityListResponse = z.infer<typeof EntityListResponseSchema>;

/**
 * Document entity link response
 */
export const DocumentEntityResponseSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  entityId: z.uuid(),
  role: entityRoleSchema,
  source: entitySourceSchema,
  confidence: z.string().nullable(),
  rawExtractedName: z.string().nullable(),
  entity: EntityResponseSchema.pick({
    id: true,
    name: true,
    type: true,
    status: true,
    imageUrl: true,
  }),
  createdAt: z.date(),
});

export type DocumentEntityResponse = z.infer<
  typeof DocumentEntityResponseSchema
>;

/**
 * Entity counts by status (for tab badges)
 */
export const EntityCountsResponseSchema = z.object({
  confirmed: z.number().int(),
  suggested: z.number().int(),
  rejected: z.number().int(),
});

export type EntityCountsResponse = z.infer<typeof EntityCountsResponseSchema>;
