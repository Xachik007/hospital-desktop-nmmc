#!/usr/bin/env node
/**
 * Upload local xlab-projects/public/desktop-updates to the live server via rsync/ssh.
 *
 * Setup once:
 *   1. cp deploy.updates.example.json deploy.updates.json
 *   2. Edit host, user, path (and optional port / sshKey)
 *   3. Ensure you can SSH: ssh user@host
 *
 * Usage:
 *   npm run deploy:updates
 *   npm run deploy:updates -- win
 *   npm run deploy:updates -- mac
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const configPath = path.join(root, 'deploy.updates.json');
const examplePath = path.join(root, 'deploy.updates.example.json');
const localRoot = path.resolve(
  root,
  '..',
  'xlab-projects',
  'public',
  'desktop-updates'
);

const platformArg = (process.argv[2] || 'all').toLowerCase();

function fail(message) {
  console.error(message);
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    fail(
      `Missing deploy.updates.json\n` +
        `Create it from the example:\n` +
        `  cp deploy.updates.example.json deploy.updates.json\n` +
        `Then edit host, user, and remote path.\n` +
        `Example file: ${examplePath}`
    );
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    fail(`Cannot read deploy.updates.json: ${err.message}`);
  }

  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  const user = typeof raw.user === 'string' ? raw.user.trim() : '';
  const remotePath = typeof raw.path === 'string' ? raw.path.trim().replace(/\/$/, '') : '';
  const port = raw.port ? Number(raw.port) : 22;
  let sshKey = typeof raw.sshKey === 'string' ? raw.sshKey.trim() : '';

  if (!host || !user || !remotePath) {
    fail('deploy.updates.json must include non-empty "host", "user", and "path".');
  }

  // Expand ~ so rsync/ssh get a real path (spawn does not expand tilde)
  if (sshKey.startsWith('~/')) {
    sshKey = path.join(os.homedir(), sshKey.slice(2));
  } else if (sshKey === '~') {
    sshKey = os.homedir();
  }

  if (sshKey && !fs.existsSync(sshKey)) {
    fail(`SSH key not found: ${sshKey}\nCheck deploy.updates.json → sshKey`);
  }

  return { host, user, remotePath, port, sshKey };
}

function ensureLocalSource(subdir) {
  const dir = subdir ? path.join(localRoot, subdir) : localRoot;
  if (!fs.existsSync(dir)) {
    fail(`Local updates folder not found: ${dir}\nRun npm run dist:mac / dist:win first.`);
  }
  const entries = fs.readdirSync(dir).filter((name) => name !== '.gitkeep');
  if (subdir && entries.length === 0) {
    fail(`Nothing to deploy in ${dir}`);
  }
  return dir;
}

function runRsync(localDir, remoteDir, config) {
  const target = `${config.user}@${config.host}:${remoteDir}/`;
  const sshParts = [`ssh`, `-p`, String(config.port || 22)];
  if (config.sshKey) {
    sshParts.push('-i', config.sshKey);
  }

  const args = [
    '-avz',
    '--progress',
    '-e',
    sshParts.join(' '),
    `${localDir}/`,
    target,
  ];

  console.log(`\nrsync ${localDir}/ → ${target}`);
  const result = spawnSync('rsync', args, { stdio: 'inherit' });
  if (result.error) {
    fail(`rsync failed: ${result.error.message}\nIs rsync installed?`);
  }
  if (result.status !== 0) {
    fail(`rsync exited with code ${result.status}`);
  }
}

function main() {
  const config = loadConfig();
  ensureLocalSource();

  const platforms = [];
  if (platformArg === 'win' || platformArg === 'all') platforms.push('win');
  if (platformArg === 'mac' || platformArg === 'all') platforms.push('mac');
  if (!platforms.length) {
    fail(`Unknown platform "${platformArg}". Use win, mac, or omit for all.`);
  }

  for (const platform of platforms) {
    const localDir = ensureLocalSource(platform);
    const remoteDir = `${config.remotePath}/${platform}`;
    runRsync(localDir, remoteDir, config);
  }

  console.log('\nDeploy finished.');
  console.log('Check:');
  if (platforms.includes('win')) {
    console.log('  https://xlab-projects.xlab.am/desktop-updates/win/latest.yml');
  }
  if (platforms.includes('mac')) {
    console.log('  https://xlab-projects.xlab.am/desktop-updates/mac/latest-mac.yml');
  }
}

try {
  main();
} catch (err) {
  fail(err.message || String(err));
}
