<!doctype html>
<html><head><meta charset="utf-8"/><title>chromHash audit</title></head>
<body>
<div id="output" style="font-family: monospace; padding: 20px; white-space: pre-wrap;"></div>
<script type="module">
import { listCheckpoints, loadCheckpoint } from '/src/ckpt.js';
const out = document.getElementById('output');
function log(s) { out.textContent += s + '\n'; }

const items = await listCheckpoints();
const panelB = items.find(it => it.name === 'sweep_chebyshev-1_mf8_s333.json');
log('panel (b) ckpt name = ' + panelB.name);
log('  bestScore (from list endpoint) = ' + panelB.bestScore);
log('  randomSeed = ' + panelB.config.randomSeed);
log('  seeds = ' + panelB.config.seeds);

const rec = await loadCheckpoint(panelB.name);
const bits = rec.bestChromBits;
log('  bits ones = ' + bits.reduce((a,b)=>a+b,0));
log('  bits.length = ' + bits.length);

// Replicate gpu_scorer.js:1236 chromHash formula
let chromHash = 0;
for (let b = 0; b < bits.length; b++) {
  chromHash = ((chromHash * 31) + bits[b]) | 0;
}
log('  chromHash (JS | 0) = ' + chromHash);
log('  chromHash (unsigned, >>>0) = ' + (chromHash >>> 0));

// Replicate production init seed formula
const randomSeed = panelB.config.randomSeed;
const s = 0; // seeds=1 → only s=0
const initSeedSigned = (randomSeed + chromHash * 65537 + s) | 0;
const initSeedUnsigned = (initSeedSigned) >>> 0;
log('  Init seed signed = ' + initSeedSigned);
log('  Init seed unsigned = ' + initSeedUnsigned);

// Also dump saved breakdown for comparison
log('  saved breakdown:');
for (const k of Object.keys(rec.bestBreakdown).sort()) {
  log('    ' + k + ': ' + rec.bestBreakdown[k]);
}
</script>
</body></html>
