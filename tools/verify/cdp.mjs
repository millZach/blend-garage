// Zero-dependency Chrome DevTools Protocol driver for headless Edge or Chrome (needs Node 22+).
// Not run directly: sweep.mjs, journey.mjs and stability.mjs import it.
// Set BROWSER_PATH to use another Chromium browser, and VERIFY_SHOTS to choose where screenshots go.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.VERIFY_SHOTS ?? path.join(os.tmpdir(), 'blend-garage-shots');
fs.mkdirSync(SHOTS, { recursive: true });

export async function launch({ width = 1600, height = 900, port = 9333, headed = false } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-edge-'));
  const args = [
    headed ? '' : '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--force_high_performance_gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    'about:blank',
  ].filter(Boolean);
  const proc = spawn(EDGE, args, { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  if (!target) throw new Error('Edge did not expose a page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args
        .map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties?.map((p) => `${p.name}:${p.value}`) ?? a.type))
        .join(' ');
      logs.push({ level: msg.params.type, text });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push({ level: 'exception', text: `${d.text} ${d.exception?.description ?? ''} @${d.url ?? ''}:${d.lineNumber}` });
    } else if (msg.method === 'Log.entryAdded') {
      logs.push({ level: `log.${msg.params.entry.level}`, text: `${msg.params.entry.text} ${msg.params.entry.url ?? ''}` });
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const page = {
    logs,
    send,
    sleep,
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(400);
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
      return r.result.value;
    },
    async waitFor(expression, timeout = 60000, poll = 250) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try {
          if (await page.eval(expression)) return true;
        } catch {
          /* page may be navigating */
        }
        await sleep(poll);
      }
      throw new Error(`waitFor timed out: ${expression}`);
    },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, name.endsWith('.png') ? name : `${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async rect(selector) {
      return page.eval(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'nearest'}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`,
      );
    },
    mouse(type, x, y, extra = {}) {
      return send('Input.dispatchMouseEvent', { type, x, y, button: 'none', buttons: 0, ...extra });
    },
    async clickAt(x, y) {
      await page.mouse('mouseMoved', x, y);
      await page.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
      await page.mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
      await sleep(60);
    },
    async click(selector) {
      const r = await page.rect(selector);
      if (!r) throw new Error(`click: no element for ${selector}`);
      await page.clickAt(r.x, r.y);
    },
    async drag(x0, y0, x1, y1, steps = 12) {
      await page.mouse('mouseMoved', x0, y0);
      await page.mouse('mousePressed', x0, y0, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await page.mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { button: 'left', buttons: 1 });
        await sleep(16);
      }
      await page.mouse('mouseReleased', x1, y1, { button: 'left', clickCount: 1 });
    },
    async key(key, type = 'keyDown', code) {
      const vk = key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Escape: 27, Enter: 13, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Shift: 16, ' ': 32 }[key];
      await send('Input.dispatchKeyEvent', { type, key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    },
    problems() {
      return logs.filter((l) => /error|exception|warning/i.test(l.level));
    },
    async close() {
      try {
        await send('Browser.close');
      } catch {
        /* already closed */
      }
      await sleep(300);
      try {
        proc.kill();
      } catch {
        /* gone */
      }
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* profile may be locked briefly */
      }
    },
  };
  return page;
}
