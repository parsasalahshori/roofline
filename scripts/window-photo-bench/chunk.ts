// A benchmark worker: evaluates the photos it is given (window index ranges), one JSON line each.
import { appendFileSync } from 'node:fs';
import { benchWindows } from './scenes.ts';
import { evaluatePhoto } from './evaluate.ts';

const [count, seed, worker, workers, outFile] = process.argv.slice(2);
const wins = benchWindows(Number(count), Number(seed));
let job = 0;
for (const w of wins) {
  for (let k = 0; k < w.photos.length; k++, job++) {
    if (job % Number(workers) !== Number(worker)) continue;
    const r = evaluatePhoto(w.id, k, w.photos[k]!, { w: w.widthIn, h: w.heightIn, offsetIn: w.offsetIn });
    appendFileSync(outFile!, JSON.stringify(r) + '\n');
  }
}
