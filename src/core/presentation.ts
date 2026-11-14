import { isEditableNode } from './perception.js';
import type { UINode } from './types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** MCP's small action index; full native evidence remains in PhoneService/SDK. */
export function compactModelData(data: Record<string, any>, limit = 60): Record<string, any> {
  if (Array.isArray(data.results))
    return {
      ...data,
      results: data.results.map((r: Record<string, any>) => compactModelData(r, limit)),
    };
  const o = data.observation;
  if (o?.format === 'phone-use.observation.v1') return data;
  if (!o || (!o.page && o.kind !== 'tree' && !o.ocr)) return data;
  const priority = (n: UINode) =>
    n.focused && isEditableNode(n)
      ? 100
      : n.semantic?.actions.length
        ? n.semantic.name
          ? 90
          : 70
        : 10;
  const chosen = new Set<string>(
    ([...o.nodes] as UINode[])
      .sort((a, b) => priority(b) - priority(a))
      .slice(0, limit)
      .map((n) => n.id),
  );
  const selected: UINode[] = o.nodes.filter((n: UINode) => chosen.has(n.id));
  const ids = new Set(selected.map((n) => n.id));
  const nodes = selected.map((n) => ({
    id: n.id,
    role: n.semantic?.role ?? 'control',
    ...(n.semantic?.name ? { name: n.semantic.name } : {}),
    ...(n.semantic?.name_truncated ? { name_truncated: true } : {}),
    ...(n.semantic?.context ? { context: n.semantic.context.name } : {}),
    ...(n.semantic?.context?.name_truncated ? { context_truncated: true } : {}),
    ...(n.semantic?.actions.length ? { actions: n.semantic.actions } : {}),
    ...(n.semantic?.target_node_id && ids.has(n.semantic.target_node_id)
      ? { tap_target: n.semantic.target_node_id }
      : {}),
    ...(!n.enabled ? { disabled: true } : {}),
    ...(n.focused && isEditableNode(n) ? { focused: true } : {}),
    ...(n.checked !== undefined &&
    (n.checkable || ['checkbox', 'switch', 'radio'].includes(n.semantic?.role ?? ''))
      ? { checked: n.checked }
      : {}),
    ...(n.selected || (n.selected !== undefined && n.semantic?.role === 'tab')
      ? { selected: n.selected }
      : {}),
    ...(n.scrollable ? { scrollable: true } : {}),
    ...(n.password ? { password: true } : {}),
    ...(isEditableNode(n) && !n.password ? { value: (n.value ?? n.text).slice(0, 160) } : {}),
    ...(!n.semantic?.name && n.resourceId ? { resource_id: n.resourceId.slice(0, 160) } : {}),
    ...(o.display
      ? {
          bounds: [n.bounds.x, n.bounds.y, n.bounds.width, n.bounds.height].map(
            (v) => Math.round(v * 10) / 10,
          ),
        }
      : {}),
  }));
  const warnings = [...new Set([...(o.warnings ?? []), ...(o.page?.reasons ?? [])])];
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const ocrItems = o.ocr?.items.filter(
    (item: any) =>
      !selected.some((node) => {
        if (
          !o.display ||
          node.semantic?.name_truncated ||
          normalize(node.semantic?.name ?? '') !== normalize(item.text)
        )
          return false;
        const a = item.bounds,
          b = node.bounds;
        const overlap =
          Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        return overlap / (a.width * a.height) >= 0.9;
      }),
  );
  return {
    ...data,
    device: data.device
      ? { platform: data.device.platform, model: data.device.model, version: data.device.version }
      : undefined,
    ...(data.device ? { device_id: data.device.id } : {}),
    observation: {
      format: 'phone-use.observation.v1',
      id: o.id,
      capturedAt: o.capturedAt,
      ...(o.kind ? { kind: o.kind, coordinate_space: o.coordinate_space } : {}),
      ...(o.display ? { display: o.display } : {}),
      nodes,
      truncated: o.truncated || selected.length < o.nodes.length,
      ...(o.page
        ? {
            page: {
              returned: nodes.length,
              matched: o.page.matched_nodes,
              total: o.page.total_nodes,
              omitted: o.page.matched_nodes - nodes.length,
              ...(o.page.query ? { query: o.page.query } : {}),
              ...(o.page.screenshot_recommended ? { needs_image: true } : {}),
            },
          }
        : {}),
      warnings,
      ...(data.device?.capabilities || o.page?.scroll_regions?.length
        ? {
            navigation: {
              ...(data.device?.capabilities
                ? { swipe: data.device.capabilities.swipe, keys: data.device.capabilities.keys }
                : {}),
              scroll_regions: (o.page?.scroll_regions ?? []).map((region: any) => ({
                id: region.node_id,
                axis: region.axis,
                bounds: [
                  region.bounds.x,
                  region.bounds.y,
                  region.bounds.width,
                  region.bounds.height,
                ].map((v: number) => Math.round(v * 10) / 10),
              })),
              coordinate_space: o.display ? 'pixels' : 'driver',
              scroll_limits: 'unknown',
            },
          }
        : {}),
      ...(o.stability ? { stability: o.stability } : {}),
      ...(o.ocr
        ? {
            ocr: {
              ...o.ocr,
              items: ocrItems.slice(0, limit),
              deduplicated: o.ocr.items.length - ocrItems.length,
              omitted: Math.max(0, ocrItems.length - limit),
            },
          }
        : {}),
    },
  };
}

/** Forward one canonical model representation. Never stringify the MCP envelope or _meta. */
export function modelContent(
  result: Pick<CallToolResult, 'content' | 'structuredContent' | 'isError'>,
): CallToolResult['content'] {
  if (result.content?.length) return result.content;
  return [
    {
      type: 'text',
      text: compactModelText(
        compactModelData(result.structuredContent ?? { isError: !!result.isError }),
      ),
    },
  ];
}

export function compactModelText(data: Record<string, any>): string {
  if (Array.isArray(data.results))
    return [
      JSON.stringify({ ...data, results: undefined }),
      ...data.results.map(compactModelText),
    ].join('\n');
  const o = data.observation;
  if (!o || !Array.isArray(o.nodes) || o.nodes.some((n: any) => n.semantic))
    return JSON.stringify(data);
  const lines = [JSON.stringify({ ...data, observation: { ...o, nodes: undefined } })];
  for (const n of o.nodes) {
    const { id, role, name, ...attributes } = n;
    lines.push(
      `[${id}] ${role} ${JSON.stringify(name ?? '')}${Object.keys(attributes).length ? ` ${JSON.stringify(attributes)}` : ''}`,
    );
  }
  return lines.join('\n');
}
