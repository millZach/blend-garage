// Usage: node tools/verify/journey.mjs [car-id] [screenshot-prefix]
// Rolls one car into the shop and uses every tool in the sidebar with real clicks: paint, bolt-ons,
// wheels and stance, the lift, all four lighting moods, car lights, camera angles, walk and fly.
// Prints a line for any step that failed and any console error or warning; saves a screenshot per step.
import { open } from './hud.mjs';
const car = process.argv[2] || 'chevrolet-corvette-c8';
const tag = process.argv[3] || 'journey';
const u = await open();
const { page, snap, click, slide } = u;
const shot = async (name) => console.log(await page.shot(`${tag}-${name}`));
const step = async (label, fn) => {
  try {
    await fn();
  } catch (e) {
    console.log(`STEP FAILED [${label}]:`, e.message);
  }
};
try {
  await u.start();
  const name = await snap(`s.cars.find(c => c.id === ${JSON.stringify(car)}).name`);
  if ((await snap(`s.selectedCarId`)) !== car) {
    await click(name, '.key-tag', false);
    await u.waitReady(car);
  }
  await page.sleep(800);
  await click('Roll it into the shop');
  await page.waitFor(`window.__garage.getSnapshot().busy === null && window.__garage.getSnapshot().screen === 'shop'`, 25000);
  await page.sleep(2600);
  await shot('01-hero-stock');

  await step('paint', async () => {
    await click('Papaya Spark', 'button', false);
    await page.sleep(500);
    console.log('paint', JSON.stringify(await snap(`(() => { const id = s.rig.roleLeads.primary; return s.build.paintZones[id]; })()`)));
    await click('Pearl');
    await slide('Roughness', 0.3);
    await page.sleep(500);
    await shot('02-painted');
    // caliper + glass quick controls
    await click('Yellow calipers').catch((e) => console.log('  (no calipers)', e.message));
    await click('Bronze tint').catch((e) => console.log('  (no glass)', e.message));
    await page.sleep(400);
  });

  await step('aero', async () => {
    await click('Aero & exterior', 'button', false);
    await page.sleep(250);
    await click('GT wing');
    await click('Touring roof box');
    await click('Front splitter', 'label', false);
    await click('Tow hook', 'label', false);
    await click('Exhaust tips', 'label', false);
    await page.sleep(700);
    console.log('aero', JSON.stringify(await snap(`s.build.universalParts`)));
    await shot('03-aero');
    await page.eval(`window.__garage.goToPreset('rear')`);
    await page.sleep(1700);
    await shot('04-aero-rear');
    await click('Ducktail');
    await click('Rally lightbar');
    await page.sleep(600);
    await shot('05-ducktail-rear');
  });

  await step('wheels', async () => {
    await click('Wheels, brakes & stance', 'button', false);
    await page.sleep(250);
    await click('Mesh dish');
    await click('Rally Gold', 'button', false);
    await slide('Ride height', -0.06);
    await slide('Camber', -4);
    await slide('Wheel spacers', 0.03);
    await slide('Front steering', 24);
    await click('Wheel', 'button');
    await page.sleep(1900);
    console.log('stance', JSON.stringify(await snap(`s.build.stance`)));
    await shot('06-wheel-closeup');
    await click('Hero');
    await page.sleep(1700);
    await shot('07-stance-hero');
  });

  await step('shop tools', async () => {
    await click('Shop tools', 'button', false);
    await page.sleep(250);
    await click('Raise');
    await page.sleep(2500);
    await shot('08-lifting');
    await page.waitFor(`!window.__garage.getSnapshot().lift.moving`, 20000);
    console.log('lift', JSON.stringify(await snap(`s.lift`)));
    await page.sleep(600);
    await shot('09-lifted-hero');
    await click('Underside');
    await page.sleep(1900);
    await shot('10-underside');
    await click('Side');
    await page.sleep(1700);
    await shot('11-lifted-side');
    await click('Headlights and taillights', 'label', false);
    for (const mood of ['Detailing studio', 'Night shift', 'Golden bay']) {
      await click(mood, 'button', false);
      await click('Hero');
      await page.sleep(2600);
      await shot(`12-mood-${mood.split(' ')[0].toLowerCase()}`);
    }
    await click('Front');
    await page.sleep(1800);
    await shot('13-golden-front-lights');
    await click('Bright daylight', 'button', false);
    await click('Lower');
    await page.waitFor(`!window.__garage.getSnapshot().lift.moving`, 20000);
    await click('Top');
    await page.sleep(1900);
    await shot('14-top');
  });

  await step('walk + fly', async () => {
    await click('Walk');
    await page.sleep(400);
    await page.key('w', 'keyDown');
    await page.sleep(900);
    await page.key('w', 'keyUp');
    await page.drag(500, 450, 760, 430, 14);
    await page.sleep(500);
    console.log('walk mode', await snap(`s.cameraMode`));
    await shot('15-walk');
    await click('Fly');
    await page.key('e', 'keyDown');
    await page.sleep(900);
    await page.key('e', 'keyUp');
    await page.key('s', 'keyDown');
    await page.sleep(700);
    await page.key('s', 'keyUp');
    await page.sleep(300);
    await shot('16-fly');
    await click('Orbit');
  });

  console.log('perf end', JSON.stringify(await snap(`s.perf`)), 'saved', await snap(`s.savedAt !== null`));
} catch (e) {
  console.log('FAILED', e.message);
  console.log(await page.shot(`${tag}-failed`).catch(() => 'no shot'));
} finally {
  console.log('PROBLEMS', JSON.stringify(page.problems().slice(0, 12), null, 1));
  await page.close();
}
