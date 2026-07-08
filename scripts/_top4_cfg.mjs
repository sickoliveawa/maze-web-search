
import fs from 'node:fs';
const ckpt_dir = 'E:/doro/maze-web/ckpt';
const top4 = ["manhattan-2_mf8_s444", "chebyshev-1_mf8_s333", "chebyshev-2_mf2_s333", "manhattan-2_mf4_s444"];

const out = {};
for (const name of top4) {
  const ckpt = JSON.parse(fs.readFileSync(`${ckpt_dir}/sweep_${name}.json`, 'utf-8'));
  const bits = ckpt.bestChromBits;
  const cfg = ckpt.config;
  // We need to re-run CA from init + steps. The ckpt only stores bestChromBits, not evolution trace.
  // So we need to: decode chromosome to Rule, run CA from init random seed, save snapshots.
  // For brevity, generate 3 snapshots: init, step 50, step 300 (final)
  // ... we'll just return initial + final from a quick re-run
  out[name] = { gridW: cfg.gridW, gridH: cfg.gridH, initDensity: cfg.initDensity, 
                randomSeed: cfg.randomSeed, caSteps: cfg.caSteps };
}
fs.writeFileSync('/tmp/top4_cfg.json', JSON.stringify(out));
console.log('OK');
