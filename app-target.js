const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function getAppExecutable(appPath) {
  try {
    const name = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 2000 }).trim();
    if (name && path.basename(name) === name) return path.join(appPath, 'Contents', 'MacOS', name);
  } catch (_) {}
  return path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'));
}

function detectAppPath() {
  const candidates = ['ChatGPT', 'Codex'].flatMap(name => [
    `/Applications/${name}.app`, path.join(os.homedir(), 'Applications', `${name}.app`)
  ]);
  return candidates.find(candidate => fs.existsSync(getAppExecutable(candidate))) || candidates[0];
}

function getCliPath(appPath) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  return [
    path.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
    path.join(resources, 'codex-cli', 'bin', 'codex'),
    path.join(resources, 'codex')
  ].find(candidate => fs.existsSync(candidate)) || path.join(resources, 'codex');
}

module.exports = { getAppExecutable, detectAppPath, getCliPath };
