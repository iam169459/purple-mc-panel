/**
 * app.js — launcher for the compiled PurpleMC server.
 *
 * The real application lives in TypeScript under src/ + routes/ and is
 * compiled to dist/. Keeping a stable root entry point means every
 * manager (PM2, install.sh, the self-updater) keeps running
 * `npm start` → `node app.js` unchanged: this file builds the server
 * (and the React client in public/) when they are missing or stale,
 * then boots the compiled entry point.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ENTRY = path.join(ROOT, 'dist', 'src', 'index.js');
const CLIENT_HTML = path.join(ROOT, 'public', 'index.html');
const SOURCE_DIRS = [path.join(ROOT, 'src'), path.join(ROOT, 'routes')];
const CLIENT_DIR = path.join(ROOT, 'client', 'src');

function newestMtime(dirs) {
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        } catch { /* ignore */ }
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return newest;
}

function run(cmd, label) {
  console.log(`[PurpleMC] ${label}…`);
  // PM2 runs with a minimal PATH that often excludes npm.  Resolve it
  // from the node binary directory so the build step always works.
  const nodeDir = path.dirname(process.execPath);
  const env = Object.assign({}, process.env, {
    PATH: nodeDir + path.delimiter + (process.env.PATH || '')
  });
  const res = spawnSync(cmd, [], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env
  });
  if (res.error || res.status !== 0) {
    console.error(`[PurpleMC] ${label} failed (exit ${res.status ?? res.error?.message}).`);
    process.exit(res.status ?? 1);
  }
}

try {
  const serverNeedsBuild = !fs.existsSync(ENTRY)
    || newestMtime(SOURCE_DIRS) > fs.statSync(ENTRY).mtimeMs;
  if (serverNeedsBuild) run('npm run build:server', 'Building server (TypeScript)');

  const clientNeedsBuild = !fs.existsSync(CLIENT_HTML)
    || newestMtime([CLIENT_DIR]) > fs.statSync(CLIENT_HTML).mtimeMs;
  if (clientNeedsBuild) run('npm run build:client', 'Building web client (Vite)');
} catch (err) {
  console.error(`[PurpleMC] Launcher error: ${err.message}`);
  process.exit(1);
}

// Boot the compiled server.
require(ENTRY);
