
import { mazeQuality, _generateDFSMaze, _generateSpiral, _generateFractalTree, _generateRandomNoise, _generateStripes } from '../src/metrics/maze_quality.js';
import fs from 'node:fs';

const W = 31, H = 31;
function makeDFS(width, height, seed = 42) {
  if (width % 2 === 0) width++; if (height % 2 === 0) height++;
  const grid = new Uint8Array(width*height).fill(1);
  const visited = new Uint8Array(width*height);
  let s = seed;
  const rand = () => { s = (s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  const carve = (x, y) => {
    visited[y*width+x] = 1; grid[y*width+x] = 0;
    const dirs = [[0,-2],[2,0],[0,2],[-2,0]];
    for (let i = dirs.length-1; i > 0; i--) { const j = Math.floor(rand()*(i+1)); [dirs[i],dirs[j]] = [dirs[j],dirs[i]]; }
    for (const [dx,dy] of dirs) {
      const nx = x+dx, ny = y+dy;
      if (nx <= 0 || nx >= width-1 || ny <= 0 || ny >= height-1) continue;
      if (visited[ny*width+nx]) continue;
      grid[((y+ny)/2)*width + (x+nx)/2] = 0;
      carve(nx, ny);
    }
  };
  carve(1, 1);
  const bellot = new Uint8Array(width*height);
  for (let i = 0; i < grid.length; i++) bellot[i] = grid[i] === 0 ? 1 : 0;
  return bellot;
}
function makePrim(W, H, seed=42) {
  const cellW=Math.floor(W/2),cellH=Math.floor(H/2);
  const g=new Uint8Array(W*H).fill(1);
  let s=seed; const rand=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};
  const v=new Uint8Array(cellW*cellH); g[1*W+1]=0; v[0]=1;
  const w=[[0,0,1,0],[0,0,0,1]];
  while(w.length){const i=Math.floor(rand()*w.length);const[cx,cy,dx,dy]=w.splice(i,1)[0];
    if(v[(cy+dy)*cellW+(cx+dx)])continue;
    g[(2*cy+1+dy)*W+(2*cx+1+dx)]=0;g[(2*(cy+dy)+1)*W+(2*(cx+dx)+1)]=0;
    v[(cy+dy)*cellW+(cx+dx)]=1;
    for(const[ddx,ddy]of[[1,0],[-1,0],[0,1],[0,-1]]){const ncx=cx+dx+ddx,ncy=cy+dy+ddy;
      if(ncx>=0&&ncx<cellW&&ncy>=0&&ncy<cellH&&!v[ncy*cellW+ncx])w.push([cx+dx,cy+dy,ddx,ddy]);}}
  const b=new Uint8Array(W*H);for(let i=0;i<g.length;i++)b[i]=g[i]===0?1:0;return b;
}
function makeKruskal(W, H, seed=42) {
  const cellW=Math.floor(W/2),cellH=Math.floor(H/2);
  const g=new Uint8Array(W*H).fill(1);
  let s=seed; const rand=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};
  const p=new Int32Array(cellW*cellH);for(let i=0;i<p.length;i++)p[i]=i;
  const find=x=>{while(p[x]!==x){p[x]=p[p[x]];x=p[x];}return x;};
  const e=[];for(let cy=0;cy<cellH;cy++)for(let cx=0;cx<cellW;cx++){if(cx<cellW-1)e.push([cx,cy,1,0]);if(cy<cellH-1)e.push([cx,cy,0,1]);}
  for(let i=e.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[e[i],e[j]]=[e[j],e[i]];}
  for(const[cx,cy,dx,dy]of e){const a=find(cy*cellW+cx),b=find((cy+dy)*cellW+(cx+dx));if(a===b)continue;p[a]=b;
    g[(2*cy+1)*W+(2*cx+1)]=0;g[(2*(cy+dy)+1)*W+(2*(cx+dx)+1)]=0;g[(2*cy+1+dy)*W+(2*cx+1+dx)]=0;}
  const b=new Uint8Array(W*H);for(let i=0;i<g.length;i++)b[i]=g[i]===0?1:0;return b;
}
function makeBinaryTree(W, H, seed=42) {
  const cellW=Math.floor(W/2),cellH=Math.floor(H/2);
  const g=new Uint8Array(W*H).fill(1);
  let s=seed; const rand=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};
  for(let cy=0;cy<cellH;cy++)for(let cx=0;cx<cellW;cx++){g[(2*cy+1)*W+(2*cx+1)]=0;
    if(cy>0&&(cx===cellW-1||rand()<0.5))g[(2*cy+1-1)*W+(2*cx+1)]=0;
    else if(cx<cellW-1)g[(2*cy+1)*W+(2*cx+1+1)]=0;}
  const b=new Uint8Array(W*H);for(let i=0;i<g.length;i++)b[i]=g[i]===0?1:0;return b;
}
function makeSidewinder(W, H, seed=42) {
  const cellW=Math.floor(W/2),cellH=Math.floor(H/2);
  const g=new Uint8Array(W*H).fill(1);
  let s=seed; const rand=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};
  for(let cy=0;cy<cellH;cy++){let rs=0;
    for(let cx=0;cx<cellW;cx++){g[(2*cy+1)*W+(2*cx+1)]=0;
      const closeOut=cx===cellW-1||(cy>0&&rand()<0.5);
      if(closeOut){if(cy>0){const x=rs+Math.floor(rand()*(cx-rs+1));g[(2*cy+1-1)*W+(2*x+1)]=0;}rs=cx+1;}
      else g[(2*cy+1)*W+(2*cx+1+1)]=0;}}
  const b=new Uint8Array(W*H);for(let i=0;i<g.length;i++)b[i]=g[i]===0?1:0;return b;
}
function makeGrowingTree(W, H, seed=42) {
  const cellW=Math.floor(W/2),cellH=Math.floor(H/2);
  const g=new Uint8Array(W*H).fill(1);
  let s=seed; const rand=()=>{s=(s*1103515245+12345)&0x7fffffff;return s/0x7fffffff;};
  const v=new Uint8Array(cellW*cellH);const a=[];
  const sx=Math.floor(rand()*cellW),sy=Math.floor(rand()*cellH);
  v[sy*cellW+sx]=1;g[(2*sy+1)*W+(2*sx+1)]=0;a.push([sx,sy]);
  while(a.length){const i=Math.floor(rand()*a.length);const[cx,cy]=a[i];const cand=[];
    for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const nx=cx+dx,ny=cy+dy;
      if(nx>=0&&nx<cellW&&ny>=0&&ny<cellH&&!v[ny*cellW+nx])cand.push([nx,ny,dx,dy]);}
    if(cand.length===0){a.splice(i,1);continue;}
    const[nx,ny,dx,dy]=cand[Math.floor(rand()*cand.length)];
    v[ny*cellW+nx]=1;g[(2*ny+1)*W+(2*nx+1)]=0;g[(2*cy+1+dy)*W+(2*cx+1+dx)]=0;a.push([nx,ny]);}
  const b=new Uint8Array(W*H);for(let i=0;i<g.length;i++)b[i]=g[i]===0?1:0;return b;
}
function makeCheckerboard(W,H){const g=new Uint8Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)g[y*W+x]=(x+y)%2;return g;}
function makeDiagonal(W,H){const g=new Uint8Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)g[y*W+x]=(x+y)%3===0?1:0;return g;}
function makeConcentric(W,H){const g=new Uint8Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++){const d=Math.min(x,y,W-1-x,H-1-y);g[y*W+x]=(d%4<2)?1:0;}return g;}
function makeHoneycomb(W,H){const g=new Uint8Array(W*H).fill(1);for(let y=0;y<H;y++)for(let x=0;x<W;x++)if((x%3===0)||(y%3===0))g[y*W+x]=0;return g;}

const true_mazes = {
  'Recursive Backtrack (DFS)': makeDFS(W, H, 42),
  'Kruskal': makeKruskal(W, H, 42),
  'Prim': makePrim(W, H, 42),
  'Growing Tree': makeGrowingTree(W, H, 42),
  'Sidewinder': makeSidewinder(W, H, 42),
  'Binary Tree': makeBinaryTree(W, H, 42),
};
const pseudo_mazes = {
  'Spiral': _generateSpiral(W, H),
  'Fractal Tree': _generateFractalTree(W, H),
  'Horizontal Stripes': _generateStripes(W, H),
  'Random Noise 50%': _generateRandomNoise(W, H, 0.5),
  'Random Noise 30%': _generateRandomNoise(W, H, 0.30),
  'Checkerboard': makeCheckerboard(W, H),
  'Diagonal Stripes': makeDiagonal(W, H),
  'Concentric Rings': makeConcentric(W, H),
  'Honeycomb': makeHoneycomb(W, H),
};
const out = { W, H,
  true: Object.fromEntries(Object.entries(true_mazes).map(([k,v])=>[k,Array.from(v)])),
  pseudo: Object.fromEntries(Object.entries(pseudo_mazes).map(([k,v])=>[k,Array.from(v)])),
};
fs.writeFileSync('/tmp/maze_grids.json', JSON.stringify(out));
console.log('OK');
