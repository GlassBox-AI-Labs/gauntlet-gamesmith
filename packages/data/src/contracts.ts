import { z } from 'zod'
import { isPublisherEmail, PUBLISHER_OTP_LENGTH, listing } from '@gauntlet/publishing'
export const credentialsSchema = z
  .object({
    email: z.email().max(254).trim(),
    password: z.string().min(1).max(200),
  })
  .strict()
const enrollmentEmail = z
  .email()
  .max(254)
  .trim()
  .refine(
    isPublisherEmail,
    'Publishing is currently in early access. Sign up with an approved email address.',
  )
export const signupSchema = z
  .object({
    email: enrollmentEmail,
    password: z.string().min(10).max(200),
    displayName: z.string().trim().min(1).max(80),
  })
  .strict()
export const verificationSchema = z
  .object({
    email: enrollmentEmail,
    code: z.string().length(PUBLISHER_OTP_LENGTH).regex(/^\d+$/),
  })
  .strict()
export const resendSchema = z.object({ email: enrollmentEmail }).strict()
export const sourceSchema = z
  .object({
    loopId: z.uuid(),
    runId: z.uuid(),
    round: z.number().int().nonnegative(),
    revision: z.string().regex(/^[a-f0-9]{40,64}$/),
  })
  .strict()
export const listingSchema = z.unknown().transform((value) => listing(value))
export const beginSchema = z
  .object({
    gameId: z.uuid(),
    requestKey: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    listing: listingSchema,
    source: sourceSchema,
  })
  .strict()
export const releaseIdSchema = z.object({ releaseId: z.uuid() }).strict()
export const promotionSchema = z
  .object({
    gameId: z.uuid(),
    releaseId: z.uuid().nullable(),
    generation: z.number().int().nonnegative(),
  })
  .strict()
export const publisherSchema = z.object({
  id: z.uuid(),
  handle: z.string(),
  display_name: z.string(),
})
export const gameSchema = z.object({
  id: z.uuid(),
  publisher_id: z.uuid(),
  slug: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  current_release_id: z.uuid().nullable(),
  generation: z.number().int().nonnegative(),
  description_override: z.string().max(2000).nullable().default(null),
  controls_override: z.string().max(500).nullable().default(null),
  cover_key: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
})
export const releaseSchema = z.object({
  id: z.uuid(),
  game_id: z.uuid(),
  digest: z.string(),
  listing: listingSchema,
  status: z.enum(['uploading', 'ready', 'failed']),
  base_generation: z.number(),
  error: z.string().nullable(),
  created_at: z.string(),
  source: sourceSchema.nullable(),
})
export const publicGamesSchema = z.array(
  z.object({
    id: z.uuid(),
    slug: z
      .string()
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    current_release_id: z.uuid(),
    cover_key: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    listing: listingSchema,
    publisher: publisherSchema.omit({ id: true }),
  }),
)
export const studioSchema = z.object({
  publisher: publisherSchema,
  games: z.array(gameSchema),
  releases: z.array(releaseSchema),
})
export type Release = z.infer<typeof releaseSchema>
export type PublicGame = z.infer<typeof publicGamesSchema>[number]
export type Studio = z.infer<typeof studioSchema>
export type MutationResult<T> =
  | { ok: true; data: T }
  | {
      ok: false
      code: 'invalid_request' | 'unauthorized' | 'conflict'
      message: string
    }

export const gameIdSchema = z.object({ gameId: z.uuid() }).strict()
export const coverUploadSchema = gameIdSchema
  .extend({ generation: z.number().int().nonnegative() })
  .strict()
export const listingUpdateSchema = coverUploadSchema
  .extend({
    description: z.string().trim().max(2000),
    controls: z.string().trim().max(500),
    coverId: z.uuid().optional(),
    coverToken: z.string().max(100).optional(),
  })
  .strict()
