import { mazeQuality, _generateDFSMaze } from '../src/metrics/maze_quality.js';

const W = 31, H = 31;
const dfs = _generateDFSMaze(W, H, 42);
console.log("DFS from _generateDFSMaze:", "1s:", Array.from(dfs).filter(x=>x===1).length, "0s:", Array.from(dfs).filter(x=>x===0).length);
console.log("corner:", dfs[0], dfs[W-1], dfs[(H-1)*W], dfs[H*W-1]);

// Try directly
const q1 = mazeQuality(dfs, W, H);
console.log("DFS mq direct:", q1.total.toFixed(3), "wall_ratio:", q1.breakdown.M_wall_ratio.toFixed(3), "M_top:", q1.breakdown.M_topology.toFixed(3));

// Invert
const inv = new Uint8Array(dfs.length);
for (let i = 0; i < dfs.length; i++) inv[i] = dfs[i] > 0 ? 0 : 1;
const q2 = mazeQuality(inv, W, H);
console.log("DFS mq inverted:", q2.total.toFixed(3), "wall_ratio:", q2.breakdown.M_wall_ratio.toFixed(3), "M_top:", q2.breakdown.M_topology.toFixed(3));

// Max
console.log("max:", Math.max(q1.total, q2.total).toFixed(3));
