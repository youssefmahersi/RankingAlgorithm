// Pin the module system of each build output.
//
// The package has no top-level "type", so Node reads dist/cjs/*.js as CommonJS by
// default; dist/esm needs the marker or its `import` statements are parsed as CJS.
// Both markers are written explicitly so the intent survives a future "type" field.
import { writeFileSync } from 'node:fs';

for (const [dir, type] of [
  ['esm', 'module'],
  ['cjs', 'commonjs'],
]) {
  writeFileSync(new URL(`../dist/${dir}/package.json`, import.meta.url), `${JSON.stringify({ type }, null, 2)}\n`);
}

console.log('build: wrote dist/esm/package.json (module) and dist/cjs/package.json (commonjs)');
