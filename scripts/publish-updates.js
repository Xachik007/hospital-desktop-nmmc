#!/usr/bin/env node
/**
 * Copies electron-builder artifacts into xlab-projects so PCs can download updates.
 *
 * Destination:
 *   ../xlab-projects/public/desktop-updates/win
 *   ../xlab-projects/public/desktop-updates/mac
 *
 * Usage:
 *   node scripts/publish-updates.js        # both platforms present in dist/
 *   node scripts/publish-updates.js win
 *   node scripts/publish-updates.js mac
 */
const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, '..', 'dist');
const destRoot = path.resolve(
  __dirname,
  '..',
  '..',
  'xlab-projects',
  'public',
  'desktop-updates'
);

const platformArg = (process.argv[2] || 'all').toLowerCase();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listDist() {
  if (!fs.existsSync(distDir)) {
    throw new Error(`dist/ not found: ${distDir}. Run a build first.`);
  }
  return fs.readdirSync(distDir);
}

function copyFile(srcName, destDir) {
  const src = path.join(distDir, srcName);
  if (!fs.existsSync(src)) return false;
  const dest = path.join(destDir, srcName);
  fs.copyFileSync(src, dest);
  const sizeMb = (fs.statSync(src).size / (1024 * 1024)).toFixed(1);
  console.log(`  + ${srcName} (${sizeMb} MB)`);
  return true;
}

function clearMatching(destDir, regex) {
  if (!fs.existsSync(destDir)) return;
  for (const name of fs.readdirSync(destDir)) {
    if (regex.test(name)) {
      fs.unlinkSync(path.join(destDir, name));
      console.log(`  - removed old ${name}`);
    }
  }
}

function publishWin(files) {
  const destDir = path.join(destRoot, 'win');
  ensureDir(destDir);
  console.log(`\nPublishing Windows updates → ${destDir}`);

  // Replace previous Windows release files
  clearMatching(
    destDir,
    /^(latest\.yml|.*Setup.*\.exe(\.blockmap)?|.*Portable.*\.exe(\.blockmap)?)$/i
  );

  let copied = 0;
  if (copyFile('latest.yml', destDir)) copied++;

  for (const name of files) {
    // Prefer NSIS setup for auto-update; also keep blockmaps
    if (/Setup.*\.exe(\.blockmap)?$/i.test(name) || /^latest\.yml$/i.test(name)) {
      if (name === 'latest.yml') continue;
      if (copyFile(name, destDir)) copied++;
    }
  }

  if (!files.includes('latest.yml')) {
    console.warn(
      '  ! latest.yml missing. Add "publish" in package.json and build with --publish never.'
    );
  }

  if (copied === 0) {
    console.warn('  ! No Windows artifacts found in dist/.');
  } else {
    console.log(`  Done (${copied} file(s)).`);
  }
}

function publishMac(files) {
  const destDir = path.join(destRoot, 'mac');
  ensureDir(destDir);
  console.log(`\nPublishing Mac updates → ${destDir}`);

  clearMatching(
    destDir,
    /^(latest-mac\.yml|.*-mac\.zip(\.blockmap)?|.*\.dmg(\.blockmap)?)$/i
  );

  let copied = 0;
  if (copyFile('latest-mac.yml', destDir)) copied++;

  for (const name of files) {
    if (
      /-mac\.zip(\.blockmap)?$/i.test(name) ||
      /\.dmg(\.blockmap)?$/i.test(name)
    ) {
      if (copyFile(name, destDir)) copied++;
    }
  }

  if (!files.includes('latest-mac.yml')) {
    console.warn(
      '  ! latest-mac.yml missing. Add "publish" in package.json and build with --publish never.'
    );
  }

  if (copied === 0) {
    console.warn('  ! No Mac artifacts found in dist/.');
  } else {
    console.log(`  Done (${copied} file(s)).`);
  }
}

function main() {
  if (!fs.existsSync(path.dirname(destRoot))) {
    throw new Error(
      `xlab-projects not found next to hospital-desktop.\nExpected: ${path.dirname(destRoot)}`
    );
  }

  ensureDir(destRoot);
  const files = listDist();

  if (platformArg === 'win' || platformArg === 'all') {
    publishWin(files);
  }
  if (platformArg === 'mac' || platformArg === 'all') {
    publishMac(files);
  }

  console.log('\nUsers will check:');
  console.log('  Windows: https://xlab-projects.xlab.am/desktop-updates/win/latest.yml');
  console.log('  Mac:     https://xlab-projects.xlab.am/desktop-updates/mac/latest-mac.yml');
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
