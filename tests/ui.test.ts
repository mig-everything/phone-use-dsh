import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, widgetHtml, UI_URI } from '../src/mcp.js';
import { PhoneService } from '../src/core/service.js';
import { Fleet } from './fleet.js';
import { previewCertificate } from './tls.js';
import { panelStream } from '../src/transport/panel-stream.js';

for (const mode of [
  'direct',
  'fallback',
  'native',
  'csp',
  'tls',
  'rtc',
  'rtc-unavailable',
  'rtc-timeout',
])
  test(
    `${mode} conversation panel: picker, independent devices, agent updates, folding, pause, dark/narrow layouts and close`,
    { timeout: 90_000 },
    async (t) => {
      const direct = !['fallback', 'csp'].includes(mode),
        native = mode === 'native' || mode === 'tls' || mode === 'rtc';
      const executable =
        process.env.PHONE_USE_CHROME ??
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome');
      try {
        await access(executable);
      } catch {
        t.skip('Set PHONE_USE_CHROME to run the browser test.');
        return;
      }
      const dir = await mkdtemp(join(tmpdir(), 'phone-use-ui-')),
        adapter = new Fleet(3);
      const tls = mode === 'tls' ? await previewCertificate(dir) : undefined;
      const service = new PhoneService(
        [adapter],
        dir,
        undefined,
        undefined,
        undefined,
        tls ? { tls } : {},
      );
      if (native) {
        const bytes = await readFile('tests/fixtures/green.h264');
        let sequence = 0;
        Object.assign(adapter, {
          async inputDisplay(device: { id: string }) {
            return (await adapter.capture(device as any)).display;
          },
          encodedVideo(device: { id: string }) {
            // A deterministic encoded test frame, until the first control changes the page.
            if (adapter.calls.length || device.id === 'demo:phone-3') return;
            return {
              codec: device.id === 'demo:phone-2' ? 'avc1.ff001e' : 'avc1.42c01e',
              width: 360,
              height: 720,
              epoch: 1,
              capturedAt: new Date().toISOString(),
              reset: true,
              packets: [{ sequence: ++sequence, timestamp: sequence * 33333, key: true, bytes }],
            };
          },
        });
      }
      const mcp = createMcpServer(service),
        client = new Client(
          { name: 'ui-host', version: '1' },
          {
            capabilities: {
              extensions: {
                'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
              },
            },
          },
        );
      const [a, b] = InMemoryTransport.createLinkedPair();
      await mcp.connect(a);
      await client.connect(b);
      const call = (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args });
      const opened = (await call('phone_open', { device_id: 'demo:phone-1' }))
        .structuredContent as any;
      const firstId = opened.session_id;
      const html = await widgetHtml();
      let initializations = 0,
        modelContextUpdates = 0;
      const host = createServer(async (req, res) => {
        try {
          if (req.url === '/widget') {
            res.setHeader('Content-Type', 'text/html');
            const resource = await client.readResource({ uri: UI_URI });
            const domains =
              ((resource.contents[0] as any)._meta.ui.csp.connectDomains as string[])
                .filter(
                  (url) =>
                    mode !== 'rtc' && (!['csp', 'tls'].includes(mode) || url.startsWith('wss:')),
                )
                .join(' ') || "'none'";
            res.setHeader(
              'Content-Security-Policy',
              `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src ${domains}`,
            );
            res.end(html);
            return;
          }
          if (req.url === '/initial') {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(await call('phone_console')));
            return;
          }
          if (req.url === '/rpc') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk);
            const message = JSON.parse(Buffer.concat(chunks).toString());
            res.setHeader('Content-Type', 'application/json');
            if (message.method === 'ui/initialize') {
              initializations++;
              res.end(
                JSON.stringify({
                  protocolVersion: '2026-01-26',
                  hostInfo: { name: 'test-host', version: '1' },
                  hostCapabilities: { serverTools: {} },
                  hostContext: {
                    theme: 'light',
                    displayMode: 'fullscreen',
                    availableDisplayModes: ['inline', 'fullscreen'],
                  },
                }),
              );
            } else if (message.method === 'ui/update-model-context') {
              modelContextUpdates++;
              res.end('{}');
            } else if (message.method === 'ui/request-display-mode')
              res.end(JSON.stringify({ mode: 'fullscreen' }));
            else if (message.method === 'tools/call') {
              if (
                (mode === 'fallback' ||
                  (mode === 'rtc-unavailable' && message.params.arguments?.rtc_offer)) &&
                message.params.name === 'phone_connect'
              )
                res.end(
                  JSON.stringify({
                    isError: true,
                    structuredContent: {
                      error: {
                        code: 'UNAVAILABLE',
                        message: 'Direct channel disabled by test host',
                      },
                    },
                  }),
                );
              else {
                const result = await client.callTool(message.params);
                if (mode === 'rtc-timeout' && message.params.arguments?.rtc_offer) {
                  const stream = result._meta!.stream as any;
                  // Valid loopback SDP, but deliberately no listener at the candidate port.
                  stream.answer.sdp = stream.answer.sdp.replace(
                    /(a=candidate:[^\r\n]* 127\.0\.0\.1 )\d+/,
                    '$19',
                  );
                }
                res.end(JSON.stringify(result));
              }
            } else throw new Error(`Unsupported UI method ${message.method}`);
            return;
          }
          res.setHeader('Content-Type', 'text/html');
          res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#fafbf9;font:14px system-ui;color:#273c33}.host-head{height:56px;border-bottom:1px solid #e3e9e3;display:flex;align-items:center;justify-content:space-between;padding:0 24px;font-size:12px;color:#718277}main{display:flex;height:1000px}aside{width:280px;flex:none;padding:38px 24px;border-right:1px solid #e3e9e3}h2{font-size:22px;letter-spacing:-1px;line-height:1.5}aside p{font-size:12px;line-height:1.9;color:#738078}.bubble{padding:16px;background:#edf3eb;border-radius:12px;margin:32px 0;font-size:13px;line-height:1.8}iframe{flex:1;width:0;height:1000px;border:0}@media(max-width:680px){aside{display:none}.host-head{padding:0 12px}} </style><div class="host-head"><strong>Phone Use / 集成预览</strong><span>协议测试宿主 · 虚拟设备</span></div><main><aside><p>CONVERSATION</p><h2>同一对话，<br>多台设备。</h2><div class="bubble">连接多台设备，在右侧查看画面和操作状态。</div><p>此页面用于验证 MCP Apps 协议与界面。左侧为测试说明，右侧运行实际插件组件。</p><p>各台设备独立采集和控制。agent 的操作结果也会更新到右侧。</p></aside><iframe title="Phone" sandbox="allow-scripts allow-downloads" src="/widget"></iframe></main><script>
        const frame=document.querySelector('iframe');
        window.addEventListener('message',async event=>{
          if(event.source!==frame.contentWindow)return;const m=event.data;
          if(m.method==='ui/notifications/initialized') {
            const data=await(await fetch('/initial')).json();frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:data},'*');
          } else if(m.id!==undefined){
            const result=await(await fetch('/rpc',{method:'POST',body:JSON.stringify(m)})).json();frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
          }
        });
        window.setTheme=theme=>frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme}},'*');
      </script></html>`);
        } catch (error) {
          res.writeHead(500).end(JSON.stringify({ error: String(error) }));
        }
      });
      await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
      // Trust only this temporary test leaf in this isolated browser process.
      // Production never changes Chromium flags or global certificate validation.
      const browser = await chromium.launch({
        executablePath: executable,
        headless: true,
        args: tls ? [`--ignore-certificate-errors-spki-list=${tls.spki}`] : [],
      });
      try {
        const until = async (check: () => Promise<boolean> | boolean) => {
          const deadline = Date.now() + 10000;
          while (!(await check())) {
            if (Date.now() > deadline) throw new Error('UI condition did not become true');
            await new Promise((r) => setTimeout(r, 40));
          }
        };
        const page = await browser.newPage({ viewport: { width: 1280, height: 1056 } }),
          errors: string[] = [];
        if (!mode.startsWith('rtc'))
          await page.addInitScript(() => {
            Object.defineProperty(window, 'RTCPeerConnection', { value: undefined });
          });
        if (mode === 'rtc')
          await page.addInitScript(() => {
            const NativeDecoder = VideoDecoder;
            // Exercise the no-GPU negotiation path while still decoding real H.264.
            (window as any).VideoDecoder = class extends NativeDecoder {
              static isConfigSupported(config: VideoDecoderConfig) {
                return config.hardwareAcceleration === 'prefer-hardware'
                  ? Promise.resolve({ config, supported: false })
                  : NativeDecoder.isConfigSupported(config);
              }
              configure(config: VideoDecoderConfig) {
                if (config.hardwareAcceleration === 'prefer-hardware')
                  throw new Error('Test host has no hardware decoder');
                super.configure(config);
              }
            };
          });
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${(host.address() as any).port}`);
        const ui = page.frameLocator('iframe'),
          first = ui.locator('[data-device-id="demo:phone-1"].card'),
          firstScreen = first.locator('.screen:not([hidden])');
        await firstScreen.waitFor({ state: 'visible' });
        if (native) await first.locator('canvas.screen').waitFor({ state: 'visible' });
        await ui.locator('#add').click();
        await ui.locator('.device-option[data-device-id="demo:phone-2"] button').click();
        const second = ui.locator('[data-device-id="demo:phone-2"].card'),
          secondScreen = second.locator('.screen:not([hidden])');
        await secondScreen.waitFor({ state: 'visible' });
        if (native) {
          await until(async () =>
            (await second.locator('.video-status').textContent())!.includes('JPEG'),
          );
          assert.equal(
            await first.locator('canvas.screen').isVisible(),
            true,
            'one unsupported device must not disable native decoding on another',
          );
          assert.equal(service.state(firstId).preview_client?.decoder, 'h264');
          const failed = service.listSessions().find((s) => s.device.id === 'demo:phone-2')!;
          assert.equal(failed.preview_client?.fallback_reason, 'unsupported');
        }
        assert.equal(await ui.locator('#workspace').getAttribute('data-mode'), 'grid');
        assert.equal(service.listSessions().length, 2);
        await ui.locator('#add').click();
        await ui.locator('.device-option[data-device-id="demo:phone-3"] button').click();
        const third = ui.locator('[data-device-id="demo:phone-3"].card');
        await third.locator('.screen:not([hidden])').waitFor({ state: 'visible' });
        await until(() =>
          [...adapter.phones.keys()].every((id) => (adapter.captures.get(id) ?? 0) >= 3),
        );
        assert.equal(service.listSessions().length, 3);
        await until(async () =>
          (await ui.locator('#connection-status').textContent())!.includes(
            direct ? '本机直连' : '兼容预览',
          ),
        );
        if (mode === 'csp') {
          await until(async () =>
            (await ui.locator('#connection-detail').textContent())!.includes('安全策略'),
          );
          assert.match((await first.locator('.video-status').textContent())!, /MCP 图片轮询/);
          await until(() => panelStream(service).report(service.panel()).client?.reason === 'csp');
          await ui.locator('#connection-status').click();
          await mkdir('.phone-use', { recursive: true });
          await page.screenshot({ path: '.phone-use/widget-connection-csp.png', fullPage: true });
          await ui.locator('#connection-status').click();
        }
        if (tls) {
          assert.match((await ui.locator('#connection-detail').textContent())!, /WSS 加密直连/);
          await until(() => panelStream(service).report(service.panel()).client?.secure === true);
        }
        if (mode === 'rtc') {
          assert.match((await ui.locator('#connection-detail').textContent())!, /WebRTC 加密直连/);
          await until(
            () => panelStream(service).report(service.panel()).client?.transport === 'webrtc',
          );
          assert.equal(panelStream(service).report(service.panel()).tls_configured, false);
          assert.equal(panelStream(service).report(service.panel()).client?.secure, true);
        }
        if (mode === 'rtc-unavailable' || mode === 'rtc-timeout') {
          await until(
            () => panelStream(service).report(service.panel()).client?.transport === 'ws',
          );
          assert.equal(
            panelStream(service).report(service.panel()).client?.rtc_failure,
            mode === 'rtc-unavailable' ? 'negotiation' : 'timeout',
          );
        }
        for (let i = 0; i < 4; i++) {
          await call('phone_focus', {
            session_id:
              i % 2
                ? firstId
                : service.listSessions().find((s) => s.device.id === 'demo:phone-2')!.session_id,
          });
        }
        await until(
          async () => (await ui.locator('#workspace').getAttribute('data-mode')) === 'focus',
        );
        assert.equal(initializations, 1, 'agent focus never creates a second widget');
        await ui.locator('#grid-mode').click();
        assert.equal(await first.locator('.detail-menu').isVisible(), false);
        const secondId = service
          .listSessions()
          .find((s) => s.device.id === 'demo:phone-2')!.session_id;
        const reused = (await call('phone_open', { device_id: 'demo:phone-2' }))
          .structuredContent as any;
        assert.equal(reused.session_id, secondId);
        // Keep the pointer held while fresh frames arrive. A mouse-down used to
        // unsubscribe video/JPEG and freeze the screen until the mouse was lifted.
        const box = (await firstScreen.boundingBox())!;
        const capturesBefore = adapter.captures.get('demo:phone-1') ?? 0;
        await firstScreen.evaluate((el) => {
          (window as any).draws = 0;
          const original = CanvasRenderingContext2D.prototype.drawImage;
          CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
            if (this.canvas === el) (window as any).draws++;
            return (original as any).apply(this, args);
          };
        });
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await until(async () =>
          native
            ? await firstScreen.evaluate(() => (window as any).draws >= 10)
            : (adapter.captures.get('demo:phone-1') ?? 0) >= capturesBefore + 5,
        );
        assert.equal(
          adapter.calls.length,
          0,
          'holding the pointer does not submit an unintended tap',
        );
        await page.mouse.up();
        await until(() => adapter.phones.get('demo:phone-1')!.active);
        assert.equal(adapter.phones.get('demo:phone-2')!.active, false);
        await until(() => first.locator('[data-control="refresh"]').isEnabled());
        await first.locator('summary').click();
        await first.locator('[data-posture="expanded"]').click();
        await until(() => adapter.phones.get('demo:phone-1')!.posture === 'expanded');
        await until(async () =>
          (await first.locator('.dimensions').textContent())!.includes('720 × 720'),
        );
        await until(() => first.locator('[data-control="refresh"]').isEnabled());
        await first.locator('summary').click();
        // A device action from the agent invalidates an unfinished manual gesture.
        const tapCount = adapter.calls.filter((c) => c.action.kind === 'tap').length;
        await firstScreen.hover();
        await page.mouse.down();
        await call('phone_act', {
          session_id: firstId,
          action: { kind: 'key', key: 'home' },
          observe: false,
        });
        await until(async () =>
          (await first.locator('.activity').textContent())!.includes('系统按键 · 已执行'),
        );
        await page.mouse.up();
        assert.equal(adapter.calls.filter((c) => c.action.kind === 'tap').length, tapCount);
        assert.equal(adapter.phones.get('demo:phone-1')!.active, false);
        await call('phone_act', {
          session_id: secondId,
          action: { kind: 'key', key: 'home' },
          observe: false,
        });
        await until(async () =>
          (await second.locator('.activity').textContent())!.includes('系统按键 · 已执行'),
        );
        await mkdir('.phone-use', { recursive: true });
        await page.screenshot({ path: '.phone-use/widget-multi.png', fullPage: true });
        await page.evaluate(() => (window as any).setTheme('dark'));
        await until(async () => (await ui.locator('html').getAttribute('data-theme')) === 'dark');
        assert.equal(
          await ui
            .locator('html')
            .evaluate((el) => getComputedStyle(el).getPropertyValue('--surface').trim()),
          '#25262c',
        );
        await until(
          async () =>
            (await first
              .locator('.controls')
              .evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(37, 38, 44)',
        );
        await page.screenshot({ path: '.phone-use/widget-dark.png', fullPage: true });
        await page.evaluate(() => (window as any).setTheme('light'));
        await first.locator('summary').click();
        await first.locator('[data-control="pause"]').click();
        await firstScreen.waitFor({ state: 'hidden' });
        assert.equal(await secondScreen.isVisible(), true);
        const paused = await call('phone_frame', { session_id: firstId });
        assert.equal(paused.isError, true);
        await first.locator('[data-control="pause"]').click();
        await firstScreen.waitFor({ state: 'visible' });
        await until(() => first.locator('[data-control="refresh"]').isEnabled());
        await first.locator('summary').click();
        adapter.broken.add('demo:phone-1');
        await first.hover();
        await first.locator('[data-control="refresh"]').click();
        await until(() => first.locator('.card-error').isVisible());
        await second.hover();
        await second.locator('[data-control="refresh"]').click();
        assert.equal(await second.locator('.card-error').isVisible(), false);
        adapter.broken.clear();
        await first.hover();
        await first.locator('[data-control="refresh"]').click();
        await until(async () => !(await first.locator('.card-error').isVisible()));
        await second.hover();
        await second.locator('[data-control="screenshot"]').click();
        await ui.locator('#capture-dialog').waitFor({ state: 'visible' });
        assert.match((await ui.locator('#capture-note').textContent())!, /画面连续稳定/);
        const downloadPromise = page.waitForEvent('download');
        await ui.locator('#save-capture').click();
        const download = await downloadPromise;
        assert.match(download.suggestedFilename(), /^phone-use-demo-.*\.png$/);
        assert.equal(await download.failure(), null);
        await ui.locator('#close-capture').click();
        await second.locator('.name').click();
        await first.waitFor({ state: 'hidden' });
        await page.setViewportSize({ width: 390, height: 1000 });
        assert.equal(await second.isVisible(), true);
        const overflow = await ui
          .locator('body')
          .evaluate((el) => el.scrollWidth > document.documentElement.clientWidth);
        assert.equal(overflow, false);
        await page.screenshot({ path: '.phone-use/widget-narrow.png', fullPage: true });
        await page.setViewportSize({ width: 1280, height: 1056 });
        await ui.locator('#grid-mode').click();
        await first.locator('summary').click();
        await first.locator('[data-control="close"]').click();
        await first.waitFor({ state: 'detached' });
        assert.equal(service.listSessions().length, 2);
        await second.locator('summary').click();
        await second.locator('[data-control="close"]').click();
        await second.waitFor({ state: 'detached' });
        await third.locator('summary').click();
        await third.locator('[data-control="close"]').click();
        await third.waitFor({ state: 'detached' });
        await ui.locator('#empty-workspace').waitFor({ state: 'visible' });
        assert.equal(service.listSessions().length, 0);
        assert.equal(initializations, 1);
        assert.ok(modelContextUpdates > 0);
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        await client.close();
        await mcp.close();
        await service.shutdown();
        await new Promise<void>((resolve) => host.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
