import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const vercelJsonCandidates = [
  path.resolve(__dirname, '../vercel.json'),
  path.resolve(process.cwd(), 'vercel.json'),
  path.resolve(process.cwd(), 'web/vercel.json'),
];

let vercelJsonPath = '';
for (const cand of vercelJsonCandidates) {
  if (fs.existsSync(cand)) {
    vercelJsonPath = cand;
    break;
  }
}

if (!vercelJsonPath) {
  console.error('\x1b[31m[DEPLOY CHECK FAILED] vercel.json file was not found.\x1b[0m');
  process.exit(1);
}

const rawContent = fs.readFileSync(vercelJsonPath, 'utf8');

if (rawContent.includes('REPLACE_WITH_RENDER_HOST')) {
  console.error('\n\x1b[31m========================================================================\x1b[0m');
  console.error('\x1b[31m[DEPLOY CHECK FAILED] vercel.json contains placeholder REPLACE_WITH_RENDER_HOST!\x1b[0m');
  console.error('\x1b[33mBefore deploying to Vercel, you must update web/vercel.json with your actual Render service hostname:\x1b[0m');
  console.error('Example: "destination": "https://newtonite-api.onrender.com/api/:path*"');
  console.error('\x1b[31m========================================================================\n\x1b[0m');
  process.exit(1);
}

try {
  const parsed = JSON.parse(rawContent);
  const apiRewrite = parsed.rewrites?.find((r) => r.source === '/api/:path*');
  if (!apiRewrite || !apiRewrite.destination.startsWith('https://')) {
    console.error('\x1b[31m[DEPLOY CHECK FAILED] vercel.json /api/:path* destination must begin with https://\x1b[0m');
    process.exit(1);
  }
} catch (err) {
  console.error('\x1b[31m[DEPLOY CHECK FAILED] vercel.json contains invalid JSON:\x1b[0m', err);
  process.exit(1);
}

console.log('\x1b[32m[DEPLOY CHECK PASSED] vercel.json has a valid production Render proxy destination configured.\x1b[0m');
process.exit(0);
