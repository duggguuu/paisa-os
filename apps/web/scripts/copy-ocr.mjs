// Copies the OCR engine (tesseract.js worker + WebAssembly core) and the English language data
// from node_modules into public/ocr, so receipt/screenshot reading runs entirely from this app.
// No third-party CDN is contacted at runtime, which lets the server send a strict "self only" CSP.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../public/ocr');
fs.mkdirSync(out, { recursive: true });
const dir = (pkg) => path.dirname(require.resolve(`${pkg}/package.json`));
const files = [
  [path.join(dir('tesseract.js'), 'dist/worker.min.js'), 'worker.min.js'],
  [path.join(dir('tesseract.js-core'), 'tesseract-core-lstm.wasm.js'), 'tesseract-core-lstm.wasm.js'],
  [path.join(dir('tesseract.js-core'), 'tesseract-core-simd-lstm.wasm.js'), 'tesseract-core-simd-lstm.wasm.js'],
  [path.join(dir('@tesseract.js-data/eng'), '4.0.0_best_int/eng.traineddata.gz'), 'eng.traineddata.gz'],
];
for (const [from, name] of files) fs.copyFileSync(from, path.join(out, name));
console.log(`OCR files copied to ${path.relative(process.cwd(), out)}`);
