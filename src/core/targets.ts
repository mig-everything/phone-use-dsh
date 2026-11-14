import { z } from 'zod';
import type { DeviceInfo, UINode } from './types.js';
import type { NodeRole } from './perception.js';

export const targetSelectorSchema = z
  .object({
    names: z.array(z.string().trim().min(1).max(160)).min(1).max(12).optional(),
    role: z
      .enum([
        'button',
        'input',
        'checkbox',
        'switch',
        'radio',
        'tab',
        'link',
        'image',
        'text',
        'scroll',
        'dialog',
        'control',
        'container',
      ])
      .optional(),
    resource_id: z.string().min(1).max(500).optional(),
    context: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
  .refine(
    (s) => !!s.names?.length || !!s.resource_id,
    'Provide names or resource_id; other fields narrow the match.',
  );
export type TargetSelector = z.infer<typeof targetSelectorSchema>;
export interface TargetCandidate {
  node_id: string;
  name: string;
  role: NodeRole;
  context?: string;
  enabled: boolean;
}
export interface TargetResolution {
  status: 'matched' | 'ambiguous' | 'missing' | 'disabled';
  resolver: string;
  selector: TargetSelector;
  selected_node_id?: string;
  candidate_count: number;
  candidates: TargetCandidate[];
}
/** Custom resolvers select existing native nodes; they do not execute device actions. */
export interface TargetResolver {
  readonly id: string;
  resolve(
    nodes: UINode[],
    selector: TargetSelector,
    device?: DeviceInfo,
  ): TargetResolution | Promise<TargetResolution>;
}
const normalized = (text: string) =>
  text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
export function matchesTarget(node: UINode, selector: TargetSelector): boolean {
  const s = node.semantic;
  return (
    !!s &&
    (!selector.names ||
      (!s.name_truncated && selector.names.map(normalized).includes(normalized(s.name)))) &&
    (!selector.role || selector.role === s.role) &&
    (!selector.resource_id || selector.resource_id === node.resourceId) &&
    (!selector.context ||
      (!s.context?.name_truncated &&
        normalized(selector.context) === normalized(s.context?.name ?? '')))
  );
}
/** Exact matching of explicit aliases. No translation, fuzzy matching or coordinate copying. */
export class ExactTargetResolver implements TargetResolver {
  readonly id = 'exact-accessibility';
  resolve(nodes: UINode[], input: TargetSelector): TargetResolution {
    const selector = targetSelectorSchema.parse(input);
    const candidates = nodes.filter((node) => {
      const s = node.semantic;
      if (
        !s ||
        !(
          node.clickable ||
          s.action_basis ||
          ['button', 'input', 'checkbox', 'switch', 'radio', 'tab', 'link'].includes(s.role)
        )
      )
        return false;
      return matchesTarget(node, selector);
    });
    const enabled = candidates.filter(
      (node) => node.enabled && node.semantic!.actions.includes('tap_node'),
    );
    return {
      resolver: this.id,
      selector,
      status:
        enabled.length === 1
          ? 'matched'
          : enabled.length > 1
            ? 'ambiguous'
            : candidates.length
              ? 'disabled'
              : 'missing',
      ...(enabled.length === 1 ? { selected_node_id: enabled[0]!.id } : {}),
      candidate_count: candidates.length,
      candidates: candidates.slice(0, 20).map((node) => ({
        node_id: node.id,
        name: node.semantic!.name,
        role: node.semantic!.role,
        context: node.semantic!.context?.name,
        enabled: node.enabled,
      })),
    };
  }
}
