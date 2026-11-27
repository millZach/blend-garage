// Usage: node tools/verify/sweep.mjs [car-id ...]
// Loads every car (or the ones named) on the selector and prints load time, wheels found, draw calls,
// fps and GPU memory for each, saving a screenshot per car. Any console error or warning is listed last.
import { launch } from './cdp.mjs';
import { URL } from './hud.mjs';
const only = process.argv.slice(2);
const page = await launch({ width: 1600, height: 900 });
const snap = (expr) => page.eval(`(() => { const s = window.__garage.getSnapshot(); return ${expr}; })()`);
try {
  await page.goto(URL);
  await page.waitFor(`window.__garage && window.__garage.getSnapshot().catalogStatus === 'ready'`, 30000);
  const cars = (await snap(`s.cars.map(c => c.id)`)).filter((id) => !only.length || only.includes(id));
  for (const car of cars) {
    const t0 = Date.now();
    await page.eval(`window.__garage.selectCar(${JSON.stringify(car)})`);
    await page.waitFor(`(() => { const s = window.__garage.getSnapshot(); return s.selectedCarId === ${JSON.stringify(car)} && s.load && (s.load.phase === 'ready' || s.load.phase === 'error'); })()`, 180000);
    const ms = Date.now() - t0;
    const load = await snap(`s.load`);
    if (load.phase === 'error') { console.log(car, 'ERROR', load.error); continue; }
    await page.sleep(2200);
    const rig = await snap(`s.rig && { wheels: s.rig.wheels.map(w=>w.corner+':'+w.radius.toFixed(2)).join(' '), wb: s.rig.wheelbase && +s.rig.wheelbase.toFixed(2), src: s.rig.sourceMeshes, draws: s.rig.drawCalls, tris: s.rig.triangles, head: s.rig.hasHeadlights, tail: s.rig.hasTaillights }`);
    const perf = await snap(`s.perf`);
    const mem = await page.eval(`window.__garage.debugInfo()`);
    console.log(car.padEnd(34), `${ms}ms`.padStart(7), `fps ${perf.fps}`.padEnd(7), `calls ${perf.drawCalls}`.padEnd(10), `geo ${mem.geometries} tex ${mem.textures}`.padEnd(16), JSON.stringify(rig));
    await page.shot(`sweep-${car}`);
  }
} catch (e) {
  console.log('FAILED', e.message);
} finally {
  console.log('PROBLEMS', JSON.stringify(page.problems().slice(0, 12), null, 1));
  await page.close();
}
