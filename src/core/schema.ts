import { z } from 'zod';
import { targetSelectorSchema } from './targets.js';
const point = { x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() };
const context = {
  observation_id: z.string().uuid(),
  space: z.enum(['pixels', 'normalized']).default('pixels'),
};
export const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap_target'), selector: targetSelectorSchema }).strict(),
  z
    .object({
      kind: z.literal('scroll_node'),
      node_id: z.string().min(1),
      observation_id: z.string().uuid(),
      direction: z.enum(['up', 'down', 'left', 'right']),
      distance: z.number().min(0.1).max(0.8).default(0.6),
      duration_ms: z.number().int().min(100).max(3000).default(400),
    })
    .strict(),
  z.object({ kind: z.literal('tap'), ...point, ...context }).strict(),
  z
    .object({
      kind: z.literal('tap_node'),
      node_id: z.string().min(1),
      observation_id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('swipe'),
      ...point,
      to_x: z.number().finite().nonnegative(),
      to_y: z.number().finite().nonnegative(),
      duration_ms: z.number().int().min(100).max(3000).default(400),
      ...context,
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      text: z
        .string()
        .min(1)
        .max(2000)
        .refine((s) => !s.includes('\0'), 'NUL is not supported'),
      observation_id: z.string().uuid(),
    })
    .strict(),
  z.object({ kind: z.literal('key'), key: z.enum(['home', 'back', 'enter']) }).strict(),
  z
    .object({
      kind: z.literal('launch'),
      app_id: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.]*$/),
      ability: z
        .string()
        .regex(/^[A-Za-z0-9_.]+$/)
        .optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('fold'), posture: z.enum(['folded', 'half-folded', 'expanded']) })
    .strict(),
]);
export type Action = z.infer<typeof actionSchema>;

export const followUpSchema = z.union([
  z.boolean(),
  z.literal('tree'),
  z
    .object({
      mode: z.enum(['tree', 'image']),
      max_nodes: z.number().int().min(1).max(500).default(60),
      query: z.string().trim().min(1).max(120).optional(),
      wait_timeout_ms: z.number().int().min(0).max(5000).default(0),
      ocr: z.enum(['auto', 'on', 'off']).default('off'),
    })
    .strict(),
]);
export type FollowUp = z.input<typeof followUpSchema>;
