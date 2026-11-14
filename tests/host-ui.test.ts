import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { DemoAdapter } from '../src/adapters/demo.js';
import { PhoneService } from '../src/core/service.js';
import { mountDsh } from '../src/hosts/dsh/index.js';
import type { Device, DriverAction } from '../src/core/types.js';

test(
  'DSH Fetch sidebar streams binary frames and sends down/move before mouseup, cancelling on hide',
  { timeout: 30_000 },
  async (t) => {
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
    class Native extends DemoAdapter {
      calls: DriverAction[] = [];
      downDelay = 0;
      pointerReady() {
        return true;
      }
      pointerInset() {
        return 12;
      }
      override async execute(_d: Device, action: DriverAction) {
        this.calls.push(action);
        if (action.kind === 'pointer' && action.phase === 'down' && this.downDelay)
          await new Promise((resolve) => setTimeout(resolve, this.downDelay));
      }
    }
    const dir = await mkdtemp(join(tmpdir(), 'phone-use-host-ui-')),
      adapter = new Native();
    const service = new PhoneService([adapter], dir),
      routes = new Map<string, (r: Request) => Promise<Response>>(),
      cleanup: (() => void)[] = [];
    mountDsh(
      {
        tools: { register() {} },
        skills: { registerProvider() {} },
        sessions: { get: (id: string) => (id === 'ui' ? { header: { id } } : undefined) },
        effect: (fn: () => () => void) => cleanup.push(fn()),
        on() {},
        inject: (_: unknown, cb: (ctx: any) => void) =>
          cb({
            connection: {
              fetch: { register: (route: any) => routes.set(route.path, route.fetch) },
            },
          }),
      },
      service,
    );
    const opened = await service.open('demo:foldable', 'dsh:ui');
    const host = createServer(async (req, res) => {
      try {
        if (req.url === '/') {
          res.setHeader('content-type', 'text/html');
          res.end(`<iframe title="Phone Use" style="width:100%;height:96vh;border:0" src="/api/phone-use/widget?session=ui"></iframe>
<script>
const frame = document.querySelector('iframe');
const call = async (name, args={}) => {
 const response = await fetch('/api/phone-use/tools?session=ui', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,arguments:args})});
 const data = await response.json();
 return response.ok ? data : {isError:true,content:[],structuredContent:{error:data.error}};
};
window.addEventListener('message', async event => {
 if(event.source!==frame.contentWindow) return;
 const m=event.data; let result={};
 if(m.method==='ui/initialize') result={protocolVersion:'2026-01-26',hostContext:{phoneUseHost:{kind:'dsh',session:'ui'},visible:true,theme:'light'}};
 else if(m.method==='tools/call') result=await call(m.params.name,m.params.arguments);
 else if(m.method==='ui/notifications/initialized') {frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:await call('phone_console')},location.origin);return;}
 if(m.id!==undefined) frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);
});
</script>`);
          return;
        }
        const url = new URL(req.url!, 'http://fixture'),
          handler = routes.get(url.pathname);
        if (!handler) {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const abort = new AbortController();
        res.once('close', () => abort.abort());
        const response = await handler(
          new Request(url, {
            method: req.method,
            signal: abort.signal,
            ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
          }),
        );
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body)
          for await (const chunk of response.body) {
            if (res.destroyed) break;
            if (!res.write(chunk)) await once(res, 'drain');
          }
        res.end();
      } catch {
        if (!res.destroyed) res.destroy();
      }
    });
    host.listen(0, '127.0.0.1');
    await once(host, 'listening');
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 780, height: 850 } });
      await page.goto(`http://127.0.0.1:${(host.address() as any).port}`);
      const frame = page.frameLocator('iframe');
      await frame
        .locator('#connection-status')
        .filter({ hasText: '宿主直连' })
        .waitFor({ timeout: 12_000 });
      const screen = frame.locator('img.screen:not([hidden])');
      await screen.waitFor();
      await screen.scrollIntoViewIfNeeded();
      const bounds = await screen.boundingBox();
      assert(bounds);
      const pixels = await screen.evaluate((element: HTMLImageElement) => ({
        width: element.naturalWidth,
        height: element.naturalHeight,
      }));
      // object-fit can leave a few pixels of letterbox inside the image element.
      // Start on the rendered phone's edge, not that non-interactive padding.
      const scale = Math.min(bounds.width / pixels.width, bounds.height / pixels.height);
      const box = {
        x: bounds.x + (bounds.width - pixels.width * scale) / 2,
        y: bounds.y + (bounds.height - pixels.height * scale) / 2,
        width: pixels.width * scale,
        height: pixels.height * scale,
      };
      const until = async (predicate: () => boolean) => {
        const end = Date.now() + 4000;
        while (!predicate() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
        assert(
          predicate(),
          JSON.stringify({
            calls: adapter.calls,
            error: await frame.locator('.card-error').allTextContents(),
          }),
        );
      };
      // A restricted edge chooses its complete-gesture route before touching
      // the device. It never starts streaming and then replays on mouseup.
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height - 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55, { steps: 8 });
      assert.equal(adapter.calls.length, 0);
      const previousImage = await screen.getAttribute('src');
      await page.mouse.up();
      await until(() => adapter.calls.some((a) => a.kind === 'swipe'));
      assert.equal(adapter.calls.length, 1);
      adapter.calls.length = 0;
      await until(() => !service.state(opened.session_id).busy);
      await page.waitForFunction((previous) => {
        const doc = document.querySelector('iframe')!.contentDocument!;
        return (
          doc.querySelector('.stage')?.getAttribute('data-busy') === 'false' &&
          doc.querySelector('img.screen')?.getAttribute('src') !== previous
        );
      }, previousImage);
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7);
      await page.mouse.down();
      await until(() => adapter.calls.some((a) => a.kind === 'pointer' && a.phase === 'down'));
      assert.equal(service.state(opened.session_id).busy, true);
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 8 });
      await until(() => adapter.calls.some((a) => a.kind === 'pointer' && a.phase === 'move'));
      assert(!adapter.calls.some((a) => a.kind === 'pointer' && a.phase === 'up'));
      // Host hides the panel during a gesture: input releases without a replayed swipe.
      await page.evaluate(() =>
        document.querySelector('iframe')!.contentWindow!.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/host-context-changed',
            params: { visible: false },
          },
          location.origin,
        ),
      );
      await until(() => !service.state(opened.session_id).busy);
      assert(adapter.calls.some((a) => a.kind === 'pointer' && a.phase === 'cancel'));
      assert(!adapter.calls.some((a) => a.kind === 'swipe'));
      await page.mouse.up();
      // Expire only the view identity. The mounted iframe must reacquire it
      // without opening another panel or replaying any device input.
      const previousPanel = service.panel('dsh:ui');
      for (let i = 0; i < 129; i++) service.panel(`expired-view-${i}`);
      assert.throws(() => service.panelScope(previousPanel), { code: 'PANEL_CLOSED' });
      const inputCount = adapter.calls.length;
      const renewed = page.waitForResponse((response) => {
        if (!response.url().includes('/api/phone-use/tools?') || !response.ok()) return false;
        const request = response.request().postDataJSON();
        return request?.name === 'phone_panel' && !request.arguments?.panel_id;
      });
      await page.evaluate(() =>
        document.querySelector('iframe')!.contentWindow!.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/host-context-changed',
            params: { visible: true },
          },
          location.origin,
        ),
      );
      await frame.getByRole('button', { name: '添加设备', exact: true }).click();
      await renewed;
      await frame.getByRole('button', { name: '重新发现', exact: true }).waitFor();
      await frame.locator('#connection-status').filter({ hasText: '宿主直连' }).waitFor();
      assert.notEqual(service.panel('dsh:ui'), previousPanel);
      assert.equal(await page.locator('iframe').count(), 1);
      assert.equal(adapter.calls.length, inputCount, 'recovering a view never replays input');
      await frame.getByRole('button', { name: '关闭设备列表', exact: true }).click();
      await frame.locator('.stage[data-busy="false"]').waitFor();
      adapter.calls.length = 0;
      adapter.downDelay = 600;
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7);
      await page.mouse.down();
      await until(() => adapter.calls.some((a) => a.kind === 'pointer' && a.phase === 'down'));
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
      await page.mouse.up();
      await until(() => adapter.calls.some((a) => a.kind === 'pointer' && a.phase === 'up'));
      assert.deepEqual(
        adapter.calls.map((a) => (a.kind === 'pointer' ? a.phase : a.kind)),
        ['down', 'move', 'move', 'up'],
        'a completed drag retains its movement even when down acknowledgement is delayed',
      );
      const anchor = adapter.calls[1],
        moved = adapter.calls[2],
        released = adapter.calls[3];
      assert(anchor?.kind === 'pointer' && moved?.kind === 'pointer');
      assert.notEqual(anchor.y, moved.y);
      assert(moved?.kind === 'pointer' && released?.kind === 'pointer');
      assert.equal(moved.x, released.x);
      assert.equal(moved.y, released.y);
      await until(() => !service.state(opened.session_id).busy);
      const lastFrame = await screen.getAttribute('src');
      await page.waitForFunction((previous) => {
        const doc = document.querySelector('iframe')!.contentDocument!;
        return (
          doc.querySelector('.stage')?.getAttribute('data-busy') === 'false' &&
          doc.querySelector('img.screen')?.getAttribute('src') !== previous
        );
      }, lastFrame);
      adapter.calls.length = 0;
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7);
      await page.mouse.down();
      await until(() => adapter.calls.some((a) => a.kind === 'pointer' && a.phase === 'down'));
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
      await page.mouse.up();
      await page.evaluate(() =>
        document.querySelector('iframe')!.contentWindow!.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/host-context-changed',
            params: { visible: false },
          },
          location.origin,
        ),
      );
      await until(() => adapter.calls.some((a) => a.kind === 'pointer' && a.phase === 'cancel'));
      assert.deepEqual(
        adapter.calls.map((a) => (a.kind === 'pointer' ? a.phase : a.kind)),
        ['down', 'cancel'],
        'hiding during a buffered drag releases the finger without introducing movement',
      );
    } finally {
      await browser.close();
      cleanup.forEach((fn) => fn());
      await service.shutdown();
      host.closeAllConnections();
      await new Promise<void>((resolve) => host.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
