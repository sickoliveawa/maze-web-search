
import fs from 'node:fs';
import { Rule } from '../src/core/rule.js';
import { Family } from '../src/core/family.js';
import { Grid } from '../src/core/grid.js';
import { Topology } from '../src/core/topology.js';
import { SeededRandom } from '../src/core/random.js';

const ckptDir = 'E:/doro/maze-web/ckpt';
const out = [];
const top4 = ['manhattan-2_mf8_s444', 'chebyshev-1_mf8_s333', 'chebyshev-2_mf2_s333', 'manhattan-2_mf4_s444'];

function decodeChromToRule(bits) {
  const families = [];
  for (let i = 0; i < 16; i++) {
    const off = i * 103;
    if (off + 103 > bits.length) break;
    if (!bits[off]) continue;
    const cellsBits = bits.slice(off + 1, off + 81);
    const BBits = bits.slice(off + 81, off + 90);
    const SBits = bits.slice(off + 90, off + 99);
    const pBits = bits.slice(off + 99, off + 103);
    const cells = [];
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      if (x === 4 && y === 4) continue;
      if (cellsBits[y*9 + x]) cells.push({ dx: x - 4, dy: y - 4 });
    }
    const B = [];
    for (let j = 0; j < 9; j++) if (BBits[j]) B.push(j);
    const S = [];
    for (let j = 0; j < 9; j++) if (SBits[j]) S.push(j);
    const p = parseInt(pBits.join(''), 2) + 1;
    families.push(new Family({ priority: p, cells, birth: B, survive: S }));
  }
  return new Rule({ families });
}

// Manual CA step using Rule
function stepCA(grid, rule, W, H, topology) {
  const newData = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const self = grid.get(x, y);
      let result = 0;
      // Iterate families by priority
      const sortedFamilies = [...rule.families].sort((a, b) => a.priority - b.priority);
      for (const fam of sortedFamilies) {
        let count = 0;
        for (const { dx, dy } of fam.cells) {
          let nx = x + dx, ny = y + dy;
          if (topology.type === 'toroidal') {
            nx = ((nx % W) + W) % W;
            ny = ((ny % H) + H) % H;
            if (grid.get(nx, ny) > 0) count++;
          } else {
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              if (grid.get(nx, ny) > 0) count++;
            }
          }
        }
        if (self === 0 && fam.birth.includes(count)) { result = 1; break; }
        if (self > 0 && fam.survive.includes(count)) { result = 1; break; }
      }
      newData[y * W + x] = result;
    }
  }
  return newData;
}

for (const name of top4) {
  const ckpt = JSON.parse(fs.readFileSync(`${ckptDir}/sweep_${name}.json`, 'utf-8'));
  const bits = ckpt.bestChromBits;
  const cfg = ckpt.config;
  const rule = decodeChromToRule(bits);
  const W = cfg.gridW, H = cfg.gridH;
  const topology = new Topology('bounded');
  
  const rng = new SeededRandom(cfg.randomSeed);
  let data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    data[y * W + x] = rng.next() < cfg.initDensity ? 1 : 0;
  }
  
  const snapshots = [Array.from(data)];
  for (let s = 1; s <= cfg.caSteps; s++) {
    data = stepCA({ get: (x,y) => data[y*W+x], set: () => {} }, rule, W, H, topology);
    if (s === 100 || s === 300) snapshots.push(Array.from(data));
  }
  out.push({ name, cfg, snapshots });
}
fs.writeFileSync('/tmp/ca_snapshots.json', JSON.stringify(out));
console.log('OK', out.length, 'rules');
