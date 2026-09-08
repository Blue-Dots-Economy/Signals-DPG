import z from 'zod';
import { ItemSnapshotSchema } from './item_schemas';

export const MatchScoreRequestSchema = z.object({
  itemA: ItemSnapshotSchema,
  itemB: ItemSnapshotSchema,
});

export const MatchScoreResponseSchema = z.object({
  provider: z.string().min(1),
  score: z.number().finite().optional(),
  band: z.string().min(1).optional(),
  confidence: z.number().finite().optional(),
  version: z.string().min(1).optional(),
  prompt_version: z.string().min(1).optional(),
  model_provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoning: z.string().min(1).optional(),
  /**
   * Why a score is ABSENT, when signals-search could not produce one:
   * `not_indexed` (404 — one side has no embedding yet) or `not_comparable`
   * (409 — the two domains have no interaction edge). Distinct from an error;
   * the response is a 200 with no `score`.
   *
   * Load-bearing on the wire, not decoration: the provider sets it and
   * `match-score-api.ts` declares it, but this schema IS the serializer —
   * fastify-type-provider-zod parses the reply through it and Zod strips keys
   * it does not name, so without this line the field was silently dropped and
   * the UI could only say "unavailable" without saying why.
   */
  unavailable_reason: z.enum(['not_indexed', 'not_comparable']).optional(),
  signals: z
    .object({
      name: z.string().min(1),
      impact: z.string().min(1),
      summary: z.string().min(1),
    })
    .array()
    .optional(),
  raw_response: z.unknown(),
});
