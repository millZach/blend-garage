// Helpers for driving the real HUD with real pointer events. Not run directly.
// The dev server must be running (npm run dev); set GARAGE_URL if it is not on http://localhost:5173/.
import { launch } from './cdp.mjs';

export const URL = process.env.GARAGE_URL ?? 'http://localhost:5173/';

export async function open({ width = 1600, height = 900 } = {}) {
  const page = await launch({ width, height });
  const snap = (expr) => page.eval(`(() => { const s = window.__garage.getSnapshot(); return ${expr}; })()`);

  /** Center of the first visible element matching `selector` whose text is (or starts with) `text`. */
  const locate = (text, selector = 'button', exact = true) =>
    page.eval(`(() => {
      const want = ${JSON.stringify(text)};
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((el) => {
        const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        const label = el.getAttribute('aria-label') || '';
        return ${exact} ? (t === want || label === want) : (t.startsWith(want) || label.startsWith(want));
      });
      const el = els.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!el.disabled };
    })()`);

  const click = async (text, selector = 'button', exact = true) => {
    const at = await locate(text, selector, exact);
    if (!at) throw new Error(`no ${selector} "${text}"`);
    if (at.disabled) throw new Error(`${selector} "${text}" is disabled`);
    await page.sleep(60);
    const again = await locate(text, selector, exact);
    await page.clickAt(again.x, again.y);
    await page.sleep(120);
  };

  /** Sets a range input (found by its label text) through the same events a drag produces. */
  const slide = (label, value) =>
    page.eval(`(() => {
      const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === ${JSON.stringify(label)});
      if (!lab) return 'no label ${label}';
      const input = document.getElementById(lab.htmlFor);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(input, String(${value}));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`);

  const waitReady = (car, timeout = 180000) =>
    page.waitFor(`(() => { const s = window.__garage && window.__garage.getSnapshot(); return s && ${car ? `s.selectedCarId === ${JSON.stringify(car)} &&` : ''} s.load && (s.load.phase === 'ready' || s.load.phase === 'error'); })()`, timeout);

  const start = async () => {
    await page.goto(URL);
    await page.waitFor(`window.__garage && window.__garage.getSnapshot().catalogStatus !== 'loading'`, 30000);
    await waitReady(null);
  };

  return { page, snap, locate, click, slide, waitReady, start };
}
