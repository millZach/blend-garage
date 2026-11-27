// Usage: node tools/verify/stability.mjs
// Switches between four cars three times over and checks that each one costs the same GPU memory every
// time it comes back and holds 60 fps: the proof that switching cars releases the previous one.
import { open, URL } from './hud.mjs';
const u = await open();
const { page, snap, click } = u;
const check = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
const cars = ['chevrolet-corvette-c8', 'lamborghini-aventador-lp700-4', 'ff1-toyota-supra-astra', 'porsche-911-gt3rs-astra-white'];
const select = async (id) => {
  await click(await snap(`s.cars.find(c => c.id === ${JSON.stringify(id)}).name`), '.key-tag', false);
  await u.waitReady(id);
  await page.sleep(1600);
  return { ...(await page.eval(`window.__garage.debugInfo()`)), fps: await snap(`s.perf.fps`) };
};
try {
  await u.start();
  await page.eval(`localStorage.clear()`);
  await page.goto(URL);
  await page.waitFor(`window.__garage && window.__garage.getSnapshot().catalogStatus !== 'loading'`, 30000);
  await u.waitReady(null);

  // Use every effect once first, so one-time shared resources (sprite quad, shader programs) already exist.
  await select(cars[0]);
  await click('Roll it into the shop');
  await page.waitFor(`window.__garage.getSnapshot().busy === null && window.__garage.getSnapshot().screen === 'shop'`, 25000);
  await page.eval(`(() => { const g = window.__garage; g.setUniversalParts({ spoiler: 'gt-wing', roof: 'rally-lightbar', wheelStyle: 'five-spoke', frontSplitter: true, towHook: true, exhaustTips: true }); g.setLights(true); g.setLiftTarget(1.2); })()`);
  await page.sleep(4500);
  await page.eval(`window.__garage.resetBuild()`);
  await page.sleep(600);
  await click('Switch car');
  await page.waitFor(`window.__garage.getSnapshot().busy === null && window.__garage.getSnapshot().screen === 'selector'`, 15000);

  const rounds = [];
  for (let round = 0; round < 3; round++) {
    const row = {};
    for (const id of cars) row[id] = await select(id);
    rounds.push(row);
    console.log(`round ${round + 1}`, cars.map((id) => `${id.split('-').slice(-2).join('-')}: geo ${row[id].geometries} tex ${row[id].textures} fps ${row[id].fps}`).join(' | '));
  }
  for (const id of cars) {
    const g = rounds.map((r) => r[id].geometries);
    const t = rounds.map((r) => r[id].textures);
    check(`${id} costs the same every time`, new Set(g).size === 1 && new Set(t).size === 1, `geometries ${g.join('/')} textures ${t.join('/')}`);
    check(`${id} holds 60 fps on the turntable`, rounds.every((r) => r[id].fps >= 57), rounds.map((r) => r[id].fps).join('/'));
  }
} catch (e) {
  console.log('FAILED', e.message);
} finally {
  const problems = page.problems();
  check('no console errors or warnings', problems.length === 0, JSON.stringify(problems.slice(0, 5)));
  await page.close();
}
