import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

console.log('====================================================');
console.log('Starting Newtonite Development Environment');
console.log('API Server: http://localhost:3000');
console.log('Web Client: http://localhost:5173');
console.log('====================================================\n');

function runProcess(prefix, prefixColor, args, cwd) {
  const child = spawn(npmCmd, args, {
    cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: isWindows,
  });

  child.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        console.log(`${prefixColor}[${prefix}]\x1b[0m ${line}`);
      }
    });
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    lines.forEach((line) => {
      if (line.trim()) {
        console.error(`${prefixColor}[${prefix}]\x1b[0m ${line}`);
      }
    });
  });

  child.on('error', (err) => {
    console.error(`Failed to start ${prefix}:`, err);
  });

  return child;
}

const serverProc = runProcess('server', '\x1b[36m', ['run', 'dev'], path.join(rootDir, 'server'));
const webProc = runProcess('web', '\x1b[35m', ['run', 'dev'], path.join(rootDir, 'web'));

function cleanup() {
  console.log('\nShutting down dev processes...');
  try {
    if (isWindows) {
      if (serverProc.pid) spawn('taskkill', ['/pid', serverProc.pid.toString(), '/T', '/F']);
      if (webProc.pid) spawn('taskkill', ['/pid', webProc.pid.toString(), '/T', '/F']);
    } else {
      serverProc.kill('SIGTERM');
      webProc.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
