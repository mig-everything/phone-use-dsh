import type { Bounds, Posture, UINode } from '../core/types.js';
import { PhoneError } from '../core/errors.js';

export function parseBounds(text: string): Bounds | undefined {
  const number = '(-?\\d+(?:\\.\\d+)?)';
  const m = text.match(new RegExp(`^\\[${number},${number}\\]\\[${number},${number}\\]$`));
  if (!m) return;
  const [x, y, right, bottom] = m.slice(1).map(Number) as [number, number, number, number];
  if (![x, y, right, bottom].every(Number.isFinite) || right <= x || bottom <= y) return;
  return { x, y, width: right - x, height: bottom - y };
}
const flag = (value: unknown, fallback = false): boolean =>
  value === undefined || value === null
    ? fallback
    : value === true || value === 1 || value === '1' || value === 'true';
const string = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 2000) : '';
const optionalString = (value: unknown): string | undefined => string(value) || undefined;
const optionalFlag = (value: unknown): boolean | undefined =>
  value === undefined || value === null ? undefined : flag(value);

export function parseHarmonyTree(root: unknown): UINode[] {
  const nodes: UINode[] = [];
  const stack: { value: any; path: string; parentId?: string }[] = [{ value: root, path: '0' }];
  let visited = 0;
  while (stack.length && visited++ < 20_000) {
    const { value: v, path, parentId } = stack.pop()!;
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--)
        stack.push({ value: v[i], path: `${path}.${i}`, parentId });
      continue;
    }
    const a = v.attributes ?? {},
      bounds = parseBounds(string(a.bounds));
    if (!flag(a.visible, true)) continue;
    let parent = parentId;
    if (bounds && flag(a.visible, true)) {
      nodes.push({
        id: path,
        parentId,
        text: string(a.text),
        description: optionalString(a.description),
        hint: optionalString(a.hint),
        type: string(a.type),
        resourceId: string(a.id || a.key),
        bounds,
        enabled: flag(a.enabled, true),
        focused: flag(a.focused),
        clickable: flag(a.clickable),
        editable: optionalFlag(a.editable),
        checkable: optionalFlag(a.checkable),
        checked: optionalFlag(a.checked),
        selected: optionalFlag(a.selected),
        scrollable: optionalFlag(a.scrollable),
        longClickable: optionalFlag(a.longClickable),
        password: optionalFlag(a.password),
      });
      parent = path;
    }
    const children = Array.isArray(v.children) ? v.children : [];
    for (let i = children.length - 1; i >= 0; i--)
      stack.push({ value: children[i], path: `${path}.${i}`, parentId: parent });
  }
  if (stack.length)
    throw new PhoneError(
      'TREE_TOO_LARGE',
      'Harmony tree exceeds the 20,000-node parsing limit; use a screenshot or a scoped export.',
    );
  return nodes;
}
function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[entity]) return named[entity]!;
    if (!entity.startsWith('#')) return match;
    const cp =
      entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
      ? String.fromCodePoint(cp)
      : '\uFFFD';
  });
}
/** Only UIAutomator node tags/attributes are read: no DTD, entity expansion or executable XML. */
export function parseAndroidTree(xml: string): UINode[] {
  const nodes: UINode[] = [],
    parents: { id?: string; visible: boolean }[] = [];
  let index = 0;
  for (const tag of xml.matchAll(/<\/?node\b(?:[^"'>]|"[^"]*"|'[^']*')*>/g)) {
    if (tag[0].startsWith('</')) {
      parents.pop();
      continue;
    }
    const a: Record<string, string> = {};
    for (const m of tag[0].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      a[m[1]!] = decodeXml(m[2] ?? m[3] ?? '');
    const bounds = parseBounds(a.bounds ?? ''),
      id = String(index++),
      parentId = parents.at(-1)?.id;
    const visible = (parents.at(-1)?.visible ?? true) && flag(a['visible-to-user'], true);
    let parent = parentId;
    if (bounds && visible) {
      nodes.push({
        id,
        parentId,
        text: string(a.text),
        description: optionalString(a['content-desc']),
        hint: optionalString(a.hint),
        type: a.class ?? '',
        resourceId: a['resource-id'] ?? '',
        packageName: optionalString(a.package),
        bounds,
        enabled: flag(a.enabled, true),
        focused: flag(a.focused),
        clickable: flag(a.clickable),
        editable: flag(a.editable, /EditText$/.test(a.class ?? '')),
        checkable: optionalFlag(a.checkable),
        checked: optionalFlag(a.checked),
        selected: optionalFlag(a.selected),
        scrollable: optionalFlag(a.scrollable),
        longClickable: optionalFlag(a['long-clickable']),
        password: optionalFlag(a.password),
      });
      parent = id;
    }
    if (!/\/\s*>$/.test(tag[0])) parents.push({ id: parent, visible });
    if (index >= 20_000)
      throw new PhoneError(
        'TREE_TOO_LARGE',
        'Android tree reached the 20,000-node parsing limit; use a screenshot or a scoped export.',
      );
  }
  return nodes;
}
export function parseIOSTree(root: any): UINode[] {
  const nodes: UINode[] = [];
  let visited = 0;
  // WDA serializes flags as "0" / "1". Preserve names separately from values.
  const walk = (v: any, path: string, depth: number, parentId?: string, parentVisible = true) => {
    if (!v) return;
    if (depth > 100 || visited++ >= 20_000)
      throw new PhoneError(
        'TREE_TOO_LARGE',
        'WDA tree exceeds the depth or node parsing limit; use a screenshot or a scoped export.',
      );
    // XCTest may mark a structural container invisible while explicitly marking
    // its children visible (e.g. SwiftUI Settings on iOS 27). Do not prune them.
    const visible = flag(v.isVisible, parentVisible);
    const b = v.rect;
    let parent = parentId;
    if (
      b &&
      [b.x, b.y, b.width, b.height].every((n) => n !== null && Number.isFinite(Number(n))) &&
      Number(b.width) > 0 &&
      Number(b.height) > 0 &&
      visible
    ) {
      nodes.push({
        id: path,
        parentId,
        text: string(v.value ?? '') || string(v.label),
        description: optionalString(v.label),
        value: v.value === undefined || v.value === null ? undefined : string(v.value),
        hint: optionalString(v.placeholderValue),
        type: string(v.type),
        resourceId: string(v.rawIdentifier || v.name),
        bounds: {
          x: Number(b.x),
          y: Number(b.y),
          width: Number(b.width),
          height: Number(b.height),
        },
        enabled: flag(v.isEnabled, true),
        focused: flag(v.isFocused),
        clickable: flag(v.isClickable),
        selected: optionalFlag(v.isSelected),
        ...(/^(XCUIElementType)?Switch$/.test(string(v.type)) &&
        ['0', '1'].includes(string(v.value))
          ? { checkable: true, checked: flag(v.value) }
          : {}),
        ...(/SecureTextField$/.test(string(v.type)) ? { password: true } : {}),
      });
      parent = path;
    }
    if (Array.isArray(v.children))
      v.children.forEach((n: any, i: number) =>
        walk(n, `${path}.${i}`, depth + 1, parent, visible),
      );
  };
  walk(root?.tree ?? root, '0', 0);
  return nodes;
}
export function parseDisplayDump(text: string): {
  id: string;
  rotation: number | null;
  posture: Posture;
} {
  // Skip historical DMS events: they may contain outdated rotations and dimensions.
  const current = text.slice(Math.max(0, text.indexOf('---------------- Screen ID:')));
  const raw = current.match(/^\s*(?:PhysicalFoldStatus|FoldStatus):\s*(\w+)/m)?.[1];
  const posture: Posture =
    raw === 'EXPAND' || raw === 'EXPANDED'
      ? 'expanded'
      : raw === 'FOLDED' || raw === 'FOLD'
        ? 'folded'
        : raw === 'HALF_FOLD' || raw === 'HALF_FOLDED'
          ? 'half-folded'
          : 'unknown';
  const rotation =
    current.match(/^\s*ScreenRotation:\s*(\d+)/m)?.[1] ??
    current.match(/^\s*Rotation:\s*(\d+)/m)?.[1];
  const r = rotation === undefined ? null : Number(rotation);
  return {
    id: current.match(/^\s*DisplayId:\s*(\d+)/m)?.[1] ?? 'default',
    rotation: r !== null && r <= 3 ? r * 90 : r,
    posture,
  };
}
