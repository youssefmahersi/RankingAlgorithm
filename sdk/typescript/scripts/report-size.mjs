// Report the shipped bundle size, gzipped, so the README figure can be checked
// rather than guessed. `npm run size`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const root = new URL('../dist/esm/', import.meta.url).pathname;

let raw = 0;
const parts = [];
for (const name of readdirSync(root)) {
  if (!name.endsWith('.js') || name === 'legacy.js') continue;
  const path = join(root, name);
  const bytes = readFileSync(path);
  raw += statSync(path).size;
  parts.push(bytes);
}

const gzipped = gzipSync(Buffer.concat(parts)).length;
const kb = (n) => `${(n / 1024).toFixed(2)} kB`;
console.log(`ESM, excluding the deprecated legacy entry point:`);
console.log(`  minified-by-nothing: ${kb(raw)}`);
console.log(`  gzipped:             ${kb(gzipped)}`);
