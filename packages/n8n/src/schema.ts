import { z } from "zod";

export const n8nNodePositionSchema = z.tuple([z.number(), z.number()]);

export const n8nNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  typeVersion: z.number().optional(),
  position: n8nNodePositionSchema,
  parameters: z.record(z.unknown()).optional(),
}).passthrough();

export type N8nNode = z.infer<typeof n8nNodeSchema>;

export const n8nConnectionSchema = z.record(
  z.string(),
  z.object({
    main: z.array(z.array(z.object({ node: z.string(), type: z.string(), index: z.number() }))),
  }),
);

export const n8nWorkflowSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  nodes: z.array(n8nNodeSchema),
  connections: z.record(z.string(), z.unknown()),
  settings: z.record(z.unknown()).optional(),
}).passthrough();

export type N8nWorkflow = z.infer<typeof n8nWorkflowSchema>;
