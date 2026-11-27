#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const INCOMING_DIR = path.join(ROOT_DIR, 'cars', 'incoming');
const PUBLIC_CARS_DIR = path.join(ROOT_DIR, 'apps', 'garage-web', 'public', 'cars');
const EXPORT_SCRIPT = path.join(__dirname, 'export_car.py');

const args = new Set(process.argv.slice(2));
const WATCH_MODE = args.has('--watch');
const FORCE_REIMPORT = args.has('--force');
const VALIDATE_ONLY = args.has('--validate-only');
const IMPORTER_VERSION = 3;

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/\.blend$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'car'
  );
}

function prettyCarName(filename) {
  return filename
    .replace(/\.blend$/i, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function findBlenderExecutable() {
  if (process.env.BLENDER_PATH && fs.existsSync(process.env.BLENDER_PATH)) {
    return process.env.BLENDER_PATH;
  }

  // Check PATH first
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  const probe = spawnSync(whichCmd, ['blender'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) {
    return probe.stdout.trim().split(/\r?\n/)[0];
  }

  // Windows standard installs (newest version first)
  if (process.platform === 'win32') {
    const baseDir = 'C:\\Program Files\\Blender Foundation';
    if (fs.existsSync(baseDir)) {
      const installs = fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

      for (const dir of installs) {
        const candidate = path.join(baseDir, dir, 'blender.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  // macOS standard install
  if (process.platform === 'darwin') {
    const macPath = '/Applications/Blender.app/Contents/MacOS/Blender';
    if (fs.existsSync(macPath)) return macPath;
  }

  return null;
}

function listIncomingBlendFiles() {
  if (!fs.existsSync(INCOMING_DIR)) {
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    return [];
  }
  return fs
    .readdirSync(INCOMING_DIR)
    .filter((f) => f.toLowerCase().endsWith('.blend'))
    .sort((a, b) => {
      const sa = fs.statSync(path.join(INCOMING_DIR, a)).size;
      const sb = fs.statSync(path.join(INCOMING_DIR, b)).size;
      return sa - sb;
    });
}

function needsImport(blendPath, outDir) {
  if (FORCE_REIMPORT) return true;
  const metaPath = path.join(outDir, 'source.meta.json');
  const glbPath = path.join(outDir, 'model.glb');
  const vehiclePath = path.join(outDir, 'vehicle.json');
  if (!fs.existsSync(metaPath) || !fs.existsSync(glbPath) || !fs.existsSync(vehiclePath)) {
    return true;
  }
  try {
    const stat = fs.statSync(blendPath);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return (
      meta.importerVersion !== IMPORTER_VERSION ||
      meta.size !== stat.size ||
      meta.mtimeMs !== stat.mtimeMs
    );
  } catch {
    return true;
  }
}

function rebuildGarageManifest() {
  fs.mkdirSync(PUBLIC_CARS_DIR, { recursive: true });
  const entries = [];
  const subdirs = fs
    .readdirSync(PUBLIC_CARS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  for (const dir of subdirs) {
    const vehiclePath = path.join(PUBLIC_CARS_DIR, dir, 'vehicle.json');
    const glbPath = path.join(PUBLIC_CARS_DIR, dir, 'model.glb');
    const thumbPath = path.join(PUBLIC_CARS_DIR, dir, 'thumbnail.png');
    if (!fs.existsSync(vehiclePath) || !fs.existsSync(glbPath)) continue;

    try {
      const v = JSON.parse(fs.readFileSync(vehiclePath, 'utf8'));
      if (v.schemaVersion !== 1 || !v.id || !v.name) {
        console.warn(`[validate] Skipping invalid vehicle.json in ${dir}`);
        continue;
      }

      const thumbnailUrl = fs.existsSync(thumbPath) ? `/cars/${v.id}/thumbnail.png` : undefined;
      if (thumbnailUrl && v.thumbnailUrl !== thumbnailUrl) {
        v.thumbnailUrl = thumbnailUrl;
        fs.writeFileSync(vehiclePath, JSON.stringify(v, null, 2) + '\n', 'utf8');
      }

      entries.push({
        id: v.id,
        name: v.name,
        author: v.author || 'Garage Builder',
        vehicleUrl: `/cars/${v.id}/vehicle.json`,
        modelUrl: `/cars/${v.id}/model.glb`,
        ...(thumbnailUrl ? { thumbnailUrl } : {}),
        importedAt: v.importedAt || new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[validate] Failed parsing ${vehiclePath}:`, err.message);
    }
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cars: entries,
  };

  fs.writeFileSync(
    path.join(PUBLIC_CARS_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf8'
  );

  return manifest;
}

function importAll() {
  fs.mkdirSync(INCOMING_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_CARS_DIR, { recursive: true });

  if (VALIDATE_ONLY) {
    const manifest = rebuildGarageManifest();
    console.log(`[blend-garage] Validated ${manifest.cars.length} car package(s).`);
    return true;
  }

  const blendFiles = listIncomingBlendFiles();
  if (blendFiles.length === 0) {
    const manifest = rebuildGarageManifest();
    console.log(
      `[blend-garage] No .blend files in cars/incoming/ yet (${manifest.cars.length} existing car package(s) indexed).`
    );
    console.log(`[blend-garage] Drop .blend files into: ${INCOMING_DIR}`);
    return true;
  }

  const blenderExe = findBlenderExecutable();
  if (!blenderExe) {
    console.error(
      '[blend-garage] Blender executable not found. Install Blender or set BLENDER_PATH=/path/to/blender'
    );
    return false;
  }

  console.log(`[blend-garage] Using Blender: ${blenderExe}`);
  let ok = true;

  for (const filename of blendFiles) {
    const blendPath = path.join(INCOMING_DIR, filename);
    const carId = slugify(filename);
    const carName = prettyCarName(filename);
    const outDir = path.join(PUBLIC_CARS_DIR, carId);

    if (!needsImport(blendPath, outDir)) {
      console.log(`[blend-garage] Up-to-date: ${filename} (${carId})`);
      continue;
    }

    fs.mkdirSync(outDir, { recursive: true });
    console.log(`[blend-garage] Importing ${filename} -> ${carId}...`);

    const result = spawnSync(
      blenderExe,
      [
        '--background',
        blendPath,
        '--python',
        EXPORT_SCRIPT,
        '--',
        '--output-dir',
        outDir,
        '--car-id',
        carId,
        '--car-name',
        carName,
        '--source-file',
        filename,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );

    if (result.status !== 0) {
      ok = false;
      console.error(`[blend-garage] Failed importing ${filename} (exit ${result.status}):`);
      if (result.stderr) console.error(result.stderr.trim());
      if (result.stdout) console.error(result.stdout.trim());
      continue;
    }

    const stat = fs.statSync(blendPath);
    fs.writeFileSync(
      path.join(outDir, 'source.meta.json'),
      JSON.stringify(
        {
          importerVersion: IMPORTER_VERSION,
          sourceFile: filename,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          importedAt: new Date().toISOString(),
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const vehicleJson = JSON.parse(fs.readFileSync(path.join(outDir, 'vehicle.json'), 'utf8'));
    const glbMb = (fs.statSync(path.join(outDir, 'model.glb')).size / (1024 * 1024)).toFixed(1);
    console.log(
      `  ✓ ${vehicleJson.name}: ${glbMb} MB | ${vehicleJson.triangleCount.toLocaleString()} tris | ` +
        `${vehicleJson.wheels.length} wheels | ${vehicleJson.parts.length} parts | ` +
        `${vehicleJson.materialZones.length} materials`
    );
    for (const hint of vehicleJson.hints || []) {
      console.log(`    ↳ Hint: ${hint}`);
    }
    // Keep manifest updated incrementally after each car finishes
    rebuildGarageManifest();
  }

  const manifest = rebuildGarageManifest();
  console.log(`[blend-garage] Garage manifest ready (${manifest.cars.length} car(s)).`);
  return ok;
}

const initialOk = importAll();

if (WATCH_MODE) {
  console.log(`[blend-garage] Watching ${INCOMING_DIR} for .blend changes...`);
  let timer = null;
  fs.watch(INCOMING_DIR, { persistent: true }, (_eventType, filename) => {
    if (!filename || !filename.toLowerCase().endsWith('.blend')) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`[blend-garage] Detected change: ${filename}`);
      importAll();
    }, 500);
  });
} else if (!initialOk) {
  process.exit(1);
}
