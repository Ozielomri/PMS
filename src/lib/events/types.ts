import { z } from "zod";

/** JSON envelope produced by private.event_envelope(); the body of every webhook. */
export const domainEventSchema = z.object({
  id: z.guid(),
  type: z.string(),
  account_id: z.guid(),
  occurred_at: z.string(),
  sequence: z.number().int(),
  transaction_id: z.string(),
  entity: z.object({ type: z.string(), id: z.string() }),
  actor: z.object({
    type: z.enum(["user", "automation", "channel", "api", "system", "agent"]),
    id: z.string().nullable(),
  }),
  data: z.record(z.string(), z.unknown()),
});

export type DomainEvent = z.infer<typeof domainEventSchema>;
