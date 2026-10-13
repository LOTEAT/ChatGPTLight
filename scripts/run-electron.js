const { spawn } = require('child_process');
const env = { ...process.env };
// Some host apps use Electron as their Node executable. Launch a desktop process here.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), process.argv.slice(2), { stdio: 'inherit', env });
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
