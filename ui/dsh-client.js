window.__ModuleLoader__.load({
  id: '@mig-everything/phone-use-dsh',
  factory: (require) => {
    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;
    const TAB = 'phone-use';
    const intents = new Map();
    function Header({ open }) {
      const [expanded, setExpanded] = useState(false),
        root = useRef(null),
        trigger = useRef(null),
        [position, setPosition] = useState({});
      useEffect(() => {
        if (!expanded) return;
        const close = (event) => {
          if (!root.current?.contains(event.target)) setExpanded(false);
        };
        const key = (event) => {
          if (event.key === 'Escape') {
            setExpanded(false);
            trigger.current?.focus();
          }
        };
        document.addEventListener('pointerdown', close);
        document.addEventListener('keydown', key);
        return () => {
          document.removeEventListener('pointerdown', close);
          document.removeEventListener('keydown', key);
        };
      }, [expanded]);
      const toggle = () => {
        const r = trigger.current.getBoundingClientRect();
        setPosition({
          top: r.bottom + 6,
          left: Math.max(8, Math.min(r.right - 208, innerWidth - 216)),
        });
        setExpanded((v) => !v);
      };
      const icon = h(
        'svg',
        {
          width: 17,
          height: 17,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          'aria-hidden': true,
        },
        h('rect', { x: 6, y: 2.5, width: 12, height: 19, rx: 3 }),
        h('path', { d: 'M10 5h4M10 18.5h4' }),
      );
      return h(
        'div',
        { ref: root, className: 'phone-use-menu' },
        h(
          'button',
          {
            ref: trigger,
            className: 'phone-use-trigger',
            title: 'Phone Use · 设备操作',
            'aria-label': 'Phone Use 设备菜单',
            'aria-haspopup': 'menu',
            'aria-expanded': expanded,
            onClick: toggle,
            onKeyDown: (e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!expanded) toggle();
                requestAnimationFrame(() =>
                  root.current?.querySelector('[role="menuitem"]')?.focus(),
                );
              }
            },
          },
          icon,
          h('span', null, 'Phone Use'),
          h(
            'svg',
            {
              width: 11,
              height: 11,
              viewBox: '0 0 12 12',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              'aria-hidden': true,
            },
            h('path', { d: 'm3 4.5 3 3 3-3' }),
          ),
        ),
        expanded &&
          h(
            'div',
            {
              role: 'menu',
              'aria-label': 'Phone Use',
              className: 'phone-use-dropdown',
              style: position,
              onKeyDown: (e) => {
                if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
                e.preventDefault();
                const items = [...root.current.querySelectorAll('[role="menuitem"]')],
                  index = items.indexOf(document.activeElement);
                items[
                  (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
                ]?.focus();
              },
            },
            h('div', { className: 'phone-use-menu-title' }, '设备工作台'),
            ...[
              ['open', '打开控制台', '查看与操作设备'],
              ['connect', '添加设备', '连接手机或模拟器'],
              ['grid', '多设备视图', '并排查看不同平台'],
            ].map(([action, label, description]) =>
              h(
                'button',
                {
                  key: action,
                  role: 'menuitem',
                  onClick: () => {
                    setExpanded(false);
                    open(action);
                    trigger.current?.focus();
                  },
                },
                h('span', null, label),
                h('small', null, description),
              ),
            ),
          ),
      );
    }
    function Panel({ sessionId, useTabInfo, expand }) {
      const frame = useRef(null),
        info = useTabInfo?.(),
        [document, setDocument] = useState(''),
        [error, setError] = useState('');
      const visibility = useRef(true);
      visibility.current = info?.tab.visible !== false;
      useEffect(() => {
        const controller = new AbortController();
        setDocument('');
        setError('');
        const endpoint = (name) =>
          `/api/phone-use/${name}?session=${encodeURIComponent(sessionId)}`;
        const call = async (name, args) => {
          const response = await fetch(endpoint('tools'), {
            method: 'POST',
            credentials: 'same-origin',
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, arguments: args }),
          });
          if (response.status === 404)
            throw new Error('Phone Use 服务正在重新加载，请稍后重新打开看板。');
          const data = await response.json();
          // Keep the shared error contract: the widget can renew an expired
          // panel on PANEL_CLOSED and must retain uncertain action outcomes.
          if (!response.ok)
            return {
              isError: true,
              content: [],
              structuredContent: {
                error: data.error ?? {
                  code: 'HOST_ERROR',
                  message: 'Phone Use connection failed.',
                  uncertain: true,
                },
              },
            };
          return data;
        };
        const notify = (method, params) =>
          frame.current?.contentWindow?.postMessage(
            { jsonrpc: '2.0', method, params },
            location.origin,
          );
        const sendIntent = () => {
          const intent = intents.get(sessionId);
          if (intent) notify('ui/notifications/host-context-changed', { phoneUseIntent: intent });
        };
        const receive = async (event) => {
          if (event.source !== frame.current?.contentWindow || event.origin !== location.origin)
            return;
          const m = event.data;
          if (!m || m.jsonrpc !== '2.0') return;
          const reply = (result) =>
            frame.current?.contentWindow?.postMessage(
              { jsonrpc: '2.0', id: m.id, result },
              location.origin,
            );
          try {
            if (m.method === 'ui/initialize')
              reply({
                protocolVersion: '2026-01-26',
                hostInfo: { name: 'DeepSeek Harness', version: '1' },
                hostCapabilities: {},
                hostContext: {
                  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
                  displayMode: 'inline',
                  availableDisplayModes: ['inline', 'fullscreen'],
                  phoneUseHost: { kind: 'dsh', session: sessionId },
                  visible: visibility.current,
                },
              });
            else if (m.method === 'ui/notifications/initialized') {
              notify('ui/notifications/tool-result', await call('phone_console', {}));
              sendIntent();
            } else if (m.method === 'tools/call')
              reply(await call(m.params.name, m.params.arguments ?? {}));
            else if (m.method === 'ui/request-display-mode') {
              expand(frame.current);
              reply({ mode: 'fullscreen' });
            } else if (m.id !== undefined) reply({});
          } catch (e) {
            if (!controller.signal.aborted)
              frame.current?.contentWindow?.postMessage(
                {
                  jsonrpc: '2.0',
                  id: m.id,
                  error: { code: -32000, message: String(e.message ?? e) },
                },
                location.origin,
              );
          }
        };
        window.addEventListener('message', receive);
        window.addEventListener('phone-use-command', sendIntent);
        fetch(endpoint('widget'), { credentials: 'same-origin', signal: controller.signal })
          .then(async (r) => {
            if (!r.ok) throw new Error((await r.json()).error?.message ?? '无法读取设备看板');
            return r.text();
          })
          .then((text) => {
            if (!controller.signal.aborted) setDocument(text);
          })
          .catch((e) => {
            if (!controller.signal.aborted) setError(String(e.message ?? e));
          });
        return () => {
          frame.current?.contentWindow?.postMessage(
            { jsonrpc: '2.0', id: 'host-teardown', method: 'ui/resource-teardown', params: {} },
            location.origin,
          );
          controller.abort();
          window.removeEventListener('message', receive);
          window.removeEventListener('phone-use-command', sendIntent);
        };
      }, [sessionId]);
      useEffect(() => {
        frame.current?.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/host-context-changed',
            params: { visible: visibility.current },
          },
          location.origin,
        );
      }, [info?.tab.visible]);
      return h(
        'section',
        {
          style: {
            display: 'flex',
            height: '100%',
            minHeight: 300,
            flexDirection: 'column',
            overflow: 'hidden',
          },
          'aria-label': 'Phone Use 多设备控制台',
        },
        error
          ? h('p', { role: 'alert', style: { padding: 20 } }, error)
          : !document
            ? h('p', { role: 'status', style: { padding: 20 } }, '正在连接设备工作台…')
            : h('iframe', {
                key: sessionId,
                ref: frame,
                title: 'Phone Use',
                srcDoc: document,
                style: { width: '100%', flex: 1, border: 0, minHeight: 300 },
                allow: 'clipboard-write; fullscreen',
              }),
      );
    }
    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent =
            '.phone-use-trigger{display:inline-flex;align-items:center;gap:6px;padding:5px 7px;border:0!important;border-radius:7px;background:transparent!important;color:inherit;font:inherit;font-size:12px;cursor:pointer;opacity:.78}.phone-use-trigger:hover,.phone-use-trigger[aria-expanded=true]{background:color-mix(in srgb,currentColor 7%,transparent)!important;opacity:1}.phone-use-trigger:focus-visible,.phone-use-dropdown button:focus-visible{outline:2px solid #739bca;outline-offset:2px}.phone-use-dropdown{position:fixed;z-index:10000;min-width:208px;padding:6px;border:1px solid #e6e7ea;border-radius:12px;background:#fff;color:#242730;box-shadow:0 8px 30px #17213518;font-family:inherit}.phone-use-menu-title{padding:7px 9px 6px;font-size:10px;letter-spacing:.08em;color:#9296a0}.phone-use-dropdown button{display:flex;flex-direction:column;gap:3px;width:100%;padding:9px;border:0;border-radius:7px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;font-size:12px}.phone-use-dropdown button:hover,.phone-use-dropdown button:focus{background:#f3f4f6}.phone-use-dropdown small{font-size:10px;color:#8a8e97}@media(prefers-color-scheme:dark){.phone-use-dropdown{background:#24262b;border-color:#ffffff18;color:#e7e9ed;box-shadow:0 8px 30px #0005}.phone-use-dropdown button:hover,.phone-use-dropdown button:focus{background:#ffffff0b}}';
          document.head.append(style);
          return () => style.remove();
        }, 'Phone Use menu styles');
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: TAB,
              kind: TAB,
              title: () => 'Phone Use',
              keepMounted: true,
              guide: [
                {
                  id: TAB,
                  order: 36,
                  title: () => 'Phone Use',
                  description: () => '鸿蒙、安卓与 iPhone 的多设备操作和实时预览',
                },
              ],
            }),
          'Phone Use sidebar',
        );
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: TAB,
                  inject: () => ({
                    expand: (source) => {
                      const target = ctx.sidebarRight.focusedTarget(source);
                      if (target) ctx.sidebarRight.toggleFullscreen(target);
                    },
                  }),
                },
                Panel,
              ),
            ),
          'Phone Use device panel',
        );
        ctx.effect(
          () =>
            ctx.slots.inject('conversation.session.header.actions', () =>
              ctx.slots.register(
                {
                  name: 'conversation.session.header.actions',
                  id: TAB,
                  order: 15,
                  inject: () => ({
                    open: (action) => {
                      const session = ctx.sidebarRight.mounted?.getSnapshot();
                      if (session)
                        intents.set(session, { id: crypto.randomUUID(), command: action });
                      ctx.sidebarRight.openTab(TAB);
                      window.dispatchEvent(new Event('phone-use-command'));
                    },
                  }),
                },
                Header,
              ),
            ),
          'Phone Use entry',
        );
      },
    };
  },
});
