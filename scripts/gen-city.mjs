// Generates an invented city into public/city/<name>.json, in the same format the old OpenStreetMap bake produced.
//   node scripts/gen-city.mjs [name] [seed]
// Layout: a 6 x 6 grid of blocks. The middle four blocks are one courthouse square (the streets through it stop at
// its edge), a river runs east-west through the row just south of it, and an elevated train loop circles the city.
// World units are metres; x runs east, z runs south (north is -z). The courthouse sits at the origin.
import fs from 'node:fs';

const [NAME = 'ratcity', SEED = '1337'] = process.argv.slice(2);
let seed = Number(SEED) >>> 0;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const between = (a, b) => a + rand() * (b - a);
const pick = (l) => l[Math.floor(rand() * l.length)];
const r2 = (v) => Math.round(v * 100) / 100;
const P2 = (x, z) => [r2(x), r2(z)];

// ------------------------------------------------------------------ the grid
const N = 6; // blocks each way
const MID = N / 2; // the street line through the middle; the square is blocks MID-1 and MID each way
const inSquareBlock = (bi, bj) => (bi === MID - 1 || bi === MID) && (bj === MID - 1 || bj === MID);
const RIVER_ROW = MID + 1; // the river runs through this row of blocks (just south of the square)
const PITCH = 110; // street centreline to centreline
const RIVER_PITCH = 160; // the river row is taller, so there is room for the river and lots on both banks
// street centrelines: x is uniform, z has the taller river row
const LX = Array.from({ length: N + 1 }, (_, i) => (i - MID) * PITCH);
const LZ = [];
{
  let z = -MID * PITCH;
  for (let j = 0; j <= N; j++) {
    LZ.push(z);
    z += j === RIVER_ROW ? RIVER_PITCH : PITCH;
  }
}
const ARTERIAL = new Set([0, N]);
const SQUARE = new Set([MID - 1, MID, MID + 1]); // the streets round the courthouse square, and the avenues leading up to it
const widthOf = (i) => (ARTERIAL.has(i) ? 16 : SQUARE.has(i) ? 14 : 11.5);
const PARKWAY = 4.0; // kerb to sidewalk centreline (the grass strip with the street trees and lamps)
const WALK_W = 3.1;
const walkOff = (i) => widthOf(i) / 2 + PARKWAY; // street centreline -> sidewalk centreline
const lotOff = (i) => walkOff(i) + WALK_W / 2 + 0.15; // street centreline -> property line
const ALLEY_W = 5.6;

const NS_NAMES = ['Mill', 'Foundry', 'Justice', 'Court', 'Liberty', 'Market', 'Ferry'].map((n) => n + ' Avenue');
const EW_NAMES = ['Cedar', 'Elm', 'Hickory', 'Court', 'Water', 'Willow', 'Juniper'].map((n) => n + ' Street');
/** the courthouse square, kerb to kerb (the streets round it bound it) */
const SQ = { x0: LX[MID - 1] + widthOf(MID - 1) / 2, x1: LX[MID + 1] - widthOf(MID + 1) / 2, z0: LZ[MID - 1] + widthOf(MID - 1) / 2, z1: LZ[MID + 1] - widthOf(MID + 1) / 2 };
const inSquare = (x, z) => x > SQ.x0 && x < SQ.x1 && z > SQ.z0 && z < SQ.z1;

const MARGIN = 45;
const X0 = LX[0] - MARGIN, X1 = LX[N] + MARGIN, Z0 = LZ[0] - MARGIN, Z1 = LZ[N] + MARGIN;

// ------------------------------------------------------------------ the river
const RIVER_HALF = 16;
const RIVER_MID = (LZ[RIVER_ROW] + LZ[RIVER_ROW + 1]) / 2;
const riverZ = (x) => RIVER_MID + 9 * Math.sin(x / 150 + 0.6) + 3 * Math.sin(x / 53 + 1.3);
const bankN = (x) => riverZ(x) - RIVER_HALF;
const bankS = (x) => riverZ(x) + RIVER_HALF;
const RIVERWALK = 4.6; // quay edge -> riverwalk centreline
const RIVER_WATER = -2.1, RIVER_FLOOR = -3.6; // relative to the bank
// each N-S street crosses on a bridge: the river is cut there, so the street and its sidewalks stay on solid ground
const BRIDGE_HALF = (i) => walkOff(i) + 2.2;
const onBridge = (x, pad = 0) => LX.some((lx, i) => Math.abs(x - lx) < BRIDGE_HALF(i) + pad);

// ------------------------------------------------------------------ the elevated loop
// the loop runs down the middle of the outermost ring of blocks (over the alleys on the north and south sides)
const LOOP = { x0: (LX[0] + LX[1]) / 2, x1: (LX[N - 1] + LX[N]) / 2, z0: (LZ[0] + LZ[1]) / 2, z1: (LZ[N - 1] + LZ[N]) / 2, r: 45 };
const TRACK_GAP = 2.3; // each track sits this far either side of the loop's centreline
function loopLine(off) {
  // a rounded rectangle, clockwise seen from above (east along the north side), offset outward by `off`
  const { x0, x1, z0, z1 } = LOOP;
  const r = LOOP.r + off;
  const out = [];
  const arc = (cx, cz, a0) => {
    for (let k = 0; k <= 12; k++) {
      const a = a0 + (k / 12) * (Math.PI / 2);
      out.push(P2(cx + Math.cos(a) * r, cz + Math.sin(a) * r));
    }
  };
  const ix0 = x0 + LOOP.r, ix1 = x1 - LOOP.r, iz0 = z0 + LOOP.r, iz1 = z1 - LOOP.r;
  arc(ix1, iz0, -Math.PI / 2); // NE corner
  arc(ix1, iz1, 0); // SE
  arc(ix0, iz1, Math.PI / 2); // SW
  arc(ix0, iz0, Math.PI); // NW
  out.push(out[0]); // closed
  return out;
}
const loopCentre = loopLine(0);
const loopSamples = [];
for (let i = 0; i + 1 < loopCentre.length; i++) {
  const a = loopCentre[i], b = loopCentre[i + 1];
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
  for (let k = 0; k < n; k++) loopSamples.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
}
/** does the rectangle come within `pad` of the elevated loop? */
const nearLoop = (x0, z0, x1, z1, pad) => loopSamples.some(([x, z]) => x > x0 - pad && x < x1 + pad && z > z0 - pad && z < z1 + pad);
const RAIL_CLEAR = 8.5;

// ------------------------------------------------------------------ output collections
const roads = [], buildings = [], rails = [], parks = [], water = [], signals = [], crossings = [], benches = [], shops = [], trees = [], bridges = [], stations = [];
const road = (k, n, w, p, extra = {}) => roads.push({ k, n, w: r2(w), o: 0, br: 0, tu: 0, sw: '', f: '', p, ...extra });
const footway = (p, w, f = '', extra = {}) => road('footway', '', w, p, { f, nx: 1, ...extra });

// ---- streets: one way per block-long segment, so road ends meet at every junction (cars link up at road ends)
for (let i = 0; i <= N; i++) {
  for (let j = 0; j < N; j++) if (!(i === MID && (j === MID - 1 || j === MID))) road(ARTERIAL.has(i) ? 'secondary' : 'residential', NS_NAMES[i], widthOf(i), [P2(LX[i], LZ[j]), P2(LX[i], LZ[j + 1])]);
}
for (let j = 0; j <= N; j++) {
  for (let i = 0; i < N; i++) if (!(j === MID && (i === MID - 1 || i === MID))) road(ARTERIAL.has(j) ? 'secondary' : 'residential', EW_NAMES[j], widthOf(j), [P2(LX[i], LZ[j]), P2(LX[i + 1], LZ[j])]);
}
// signals where two big streets meet
const big = (i) => ARTERIAL.has(i) || SQUARE.has(i);
for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) if (big(i) && big(j) && !(i === MID && j === MID)) signals.push(P2(LX[i], LZ[j]));

// ---- the river: a strip cut at every bridge into separate basins
{
  const xs = [];
  for (let x = X0; x <= X1; x += 4) xs.push(x);
  if (xs[xs.length - 1] < X1) xs.push(X1);
  // split points: both edges of every bridge
  const cuts = [];
  LX.forEach((lx, i) => cuts.push(lx - BRIDGE_HALF(i), lx + BRIDGE_HALF(i)));
  const spans = [];
  let start = X0;
  for (let k = 0; k < cuts.length; k += 2) {
    spans.push([start, cuts[k]]);
    start = cuts[k + 1];
  }
  spans.push([start, X1]);
  for (const [a, b] of spans) {
    if (b - a < 4) continue;
    const sx = [a, ...xs.filter((x) => x > a + 1 && x < b - 1), b];
    water.push([...sx.map((x) => P2(x, bankN(x))), ...[...sx].reverse().map((x) => P2(x, bankS(x)))]);
  }
  LX.forEach((lx, i) => bridges.push({ x: r2(lx), z0: r2(bankN(lx) - 0.5), z1: r2(bankS(lx) + 0.5), half: r2(walkOff(i) + WALK_W / 2 + 0.3), cut: r2(BRIDGE_HALF(i)), name: NS_NAMES[i] }));
}

// ---- the elevated loop: two tracks, and four stations
rails.push({ k: 'subway', el: 1, p: loopLine(TRACK_GAP) });
rails.push({ k: 'subway', el: 1, p: loopLine(-TRACK_GAP) });
{
  const short = (n) => n.replace(/ (Avenue|Street)$/, '').toUpperCase();
  stations.push({ p: P2(LX[MID - 1], LOOP.z0), name: short(NS_NAMES[MID - 1]) });
  stations.push({ p: P2(LOOP.x1, LZ[MID - 1]), name: short(EW_NAMES[MID - 1]) });
  stations.push({ p: P2(LX[MID + 1], LOOP.z1), name: short(NS_NAMES[MID + 1]) });
  stations.push({ p: P2(LOOP.x0, LZ[MID - 2]), name: short(EW_NAMES[MID - 2]) });
}

// ------------------------------------------------------------------ blocks
const SHOP_WORDS = {
  first: ['Rosa', 'Golden', 'Blue Door', 'Old Mill', 'Corner', 'Lucky', 'Union', 'River', 'Little', 'Harbor', 'Mister', 'Grand', 'Night Owl', 'Sunny', 'Iron', 'Lantern', 'Crown', 'Copper', 'Penny', 'Maple'],
  kinds: [['Deli', 'deli'], ['Bakery', 'bakery'], ['Diner', 'restaurant'], ['Pizza', 'restaurant'], ['Tavern', 'bar'], ['Coffee', 'cafe'], ['Books', 'books'], ['Hardware', 'hardware'], ['Pharmacy', 'pharmacy'], ['Laundromat', 'laundry'], ['Tailor', 'tailor'], ['Noodles', 'restaurant'], ['Records', 'music'], ['Florist', 'florist'], ['Grocery', 'convenience'], ['Barber', 'hairdresser'], ['Bank', 'bank'], ['Tacos', 'fast_food'], ['Dumplings', 'restaurant'], ['Cinema', 'cinema']],
};
const shopName = () => {
  const [k, kind] = pick(SHOP_WORDS.kinds);
  return { name: `${pick(SHOP_WORDS.first)} ${k}`, kind };
};
const rect = (x0, z0, x1, z1) => [P2(x0, z0), P2(x1, z0), P2(x1, z1), P2(x0, z1)];
const area = (x0, z0, x1, z1) => Math.abs((x1 - x0) * (z1 - z0));
/** ground kept for the stores (and their lots): no ordinary building may overlap these */
const reserved = [];
const addBuilding = (t, levels, x0, z0, x1, z1, name = '') => {
  if (x1 - x0 < 3 || z1 - z0 < 3) return false;
  if (nearLoop(x0, z0, x1, z1, RAIL_CLEAR)) return false;
  if (reserved.some((r) => x0 < r[2] + 1 && x1 > r[0] - 1 && z0 < r[3] + 1 && z1 > r[1] - 1)) return false;
  buildings.push({ t, l: levels, h: 0, n: name, a: r2(area(x0, z0, x1, z1)), p: rect(x0, z0, x1, z1) });
  return true;
};

const PARK_BLOCKS = new Map([
  ['0,4', 'lawn'], ['5,1', 'lawn'],
]);

// ---- stores with interiors: the grocery takes a whole block; gas stations take a corner of a block
const GROCERY_BLOCK = '1,3';
const GAS_CORNERS = new Map([
  ['4,1', { sx: 1, sz: -1, name: 'CHEDDAR GAS' }], // north-east corner of the block
  ['1,1', { sx: -1, sz: -1, name: 'QUIK RAT' }],
  ['4,3', { sx: 1, sz: 1, name: 'RATCO' }],
]);
const stores = [];
const sortRect = (a, b, c, d) => [r2(Math.min(a, c)), r2(Math.min(b, d)), r2(Math.max(a, c)), r2(Math.max(b, d))];

/**
 * A gas station in one corner of a block. Laid out in corner-local metres: u runs in from the side street, v in from
 * the front street. The canopy and pumps sit near the corner, the shop at the back with its door to the forecourt.
 */
function gasStation(px0, pz0, px1, pz1, g) {
  const cx = g.sx > 0 ? px1 : px0, cz = g.sz < 0 ? pz0 : pz1;
  const W = (u, v) => [cx - g.sx * u, cz - g.sz * v];
  const R = (u0, v0, u1, v1) => {
    const a = W(u0, v0), b = W(u1, v1);
    return sortRect(a[0], a[1], b[0], b[1]);
  };
  const lot = R(0, 0, 42, 36);
  reserved.push(lot);
  const pumps = [];
  for (const v of [7.6, 12.4]) for (const u of [9.5, 18.5]) {
    const [x, z] = W(u, v);
    pumps.push([r2(x), r2(z)]);
  }
  stores.push({
    kind: 'gas', name: g.name,
    rect: R(25, 22, 39, 32), // the shop: 14 x 10
    door: g.sz < 0 ? 'n' : 's', // the shop faces the front street, across the forecourt
    canopy: R(4, 4, 24, 16),
    islands: [R(6.5, 6.9, 21.5, 8.3), R(6.5, 11.7, 21.5, 13.1)],
    pumps,
    pylon: W(2.2, 2.2).map(r2),
    lot,
  });
}

/** The grocery: a big box at the back of its block, its doors facing a parking lot along the south street. */
function grocery(px0, pz0, px1, pz1) {
  const cx = (px0 + px1) / 2;
  const rect = sortRect(cx - 24, pz0 + 3, cx + 24, pz0 + 33);
  const lot = sortRect(px0 + 2, pz0 + 1, px1 - 2, pz1 - 1);
  reserved.push(lot);
  stores.push({ kind: 'grocery', name: 'FRESH MART', rect, door: 's', lot, stalls: sortRect(px0 + 6, rect[3] + 9, px1 - 6, pz1 - 4) });
}

/** the sidewalk ring round a block; extra vertices (where paths join it) are passed per side */
function sidewalkRing(x0, z0, x1, z1, extra = { n: [], e: [], s: [], w: [] }) {
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const n = [mx, ...extra.n].filter((x) => x > x0 + 0.5 && x < x1 - 0.5);
  const e = [mz, ...extra.e].filter((z) => z > z0 + 0.5 && z < z1 - 0.5);
  const s = [mx, ...extra.s].filter((x) => x > x0 + 0.5 && x < x1 - 0.5);
  const w = [mz, ...extra.w].filter((z) => z > z0 + 0.5 && z < z1 - 0.5);
  // start mid-way along the north side, so neither end of the polyline sits at a corner
  const pts = [P2(mx, z0)];
  for (const x of [...new Set(n)].sort((a, b) => a - b)) if (x > mx) pts.push(P2(x, z0));
  pts.push(P2(x1, z0));
  for (const z of [...new Set(e)].sort((a, b) => a - b)) pts.push(P2(x1, z));
  pts.push(P2(x1, z1));
  for (const x of [...new Set(s)].sort((a, b) => b - a)) pts.push(P2(x, z1));
  pts.push(P2(x0, z1));
  for (const z of [...new Set(w)].sort((a, b) => b - a)) pts.push(P2(x0, z));
  pts.push(P2(x0, z0));
  for (const x of [...new Set(n)].sort((a, b) => a - b)) if (x < mx) pts.push(P2(x, z0));
  pts.push(P2(mx, z0));
  footway(pts, WALK_W, 'sidewalk');
}

/** a face of lots along one street. `dir` is +1 when the lots grow south from z = front, -1 when they grow north. */
function lotFace(o) {
  const { x0, x1, front, dir, depthAt, zone, arterial } = o;
  let x = x0;
  while (x1 - x > 4) {
    const wide = zone === 'downtown' ? between(20, 34) : zone === 'mixed' ? between(12, 18) : between(11, 15);
    let w = Math.min(wide, x1 - x);
    if (x1 - x - w < (zone === 'downtown' ? 12 : 7)) w = x1 - x; // last lot takes the remainder
    const lx0 = x, lx1 = x + w;
    x = lx1;
    // the deepest the lot can go here (the alley, the river walk or the block's middle)
    const room = Math.min(depthAt(lx0), depthAt(lx1), depthAt((lx0 + lx1) / 2));
    if (room < 9) continue;
    let set = 0, deep = 0, gap = 0, t = 'yes', levels = 0, shop = false;
    if (zone === 'downtown') {
      set = 0.3;
      deep = Math.min(room - 1.5, between(26, 40));
      gap = rand() < 0.2 ? 1.5 : 0;
      t = rand() < 0.5 ? 'office' : 'commercial';
      levels = o.ring <= 1 ? Math.round(between(6, 13)) : Math.round(between(4, 8));
      shop = true;
    } else if (zone === 'mixed' || (arterial && rand() < 0.6)) {
      if (arterial) {
        set = 0.3;
        deep = Math.min(room - 2, between(18, 26));
        t = 'retail';
        levels = Math.round(between(2, 4));
        shop = true;
      } else {
        set = between(1.0, 2.6);
        deep = Math.min(room - set - 2, between(16, 22));
        gap = between(0.8, 1.4);
        t = 'apartments';
        levels = 3;
      }
    } else {
      // most houses sit close to the sidewalk; about one in four has a fenced front yard (fences are heavy geometry)
      set = rand() < 0.25 ? between(3.8, 5.5) : between(1.0, 2.6);
      deep = Math.min(room - set - 3, between(14, 20));
      gap = between(1.0, 1.6);
      t = rand() < 0.3 ? 'apartments' : 'yes';
      levels = rand() < 0.55 ? 2 : 3;
    }
    if (deep < 8) continue;
    const bx0 = lx0 + gap / 2, bx1 = lx1 - gap / 2;
    const f = front + dir * set, b = front + dir * (set + deep);
    const zA = Math.min(f, b), zB = Math.max(f, b);
    if (!addBuilding(t, levels, bx0, zA, bx1, zB)) continue;
    if (shop) {
      const s = shopName();
      shops.push({ p: P2((bx0 + bx1) / 2, front - dir * 1.2), name: s.name, kind: s.kind });
    }
    // a garage on the alley behind the house
    if (zone === 'res' && o.alley !== null && rand() < 0.2) {
      const gz1 = o.alley - dir * (ALLEY_W / 2 + 0.8), gz0 = gz1 - dir * 6.2;
      const back = front + dir * (set + deep);
      if (Math.abs(gz0 - back) > 6 && (bx1 - bx0) > 7) {
        const gx = (bx0 + bx1) / 2;
        addBuilding('garage', 1, gx - 3.2, Math.min(gz0, gz1), gx + 3.2, Math.max(gz0, gz1));
      }
    }
  }
}

for (let bi = 0; bi < N; bi++) {
  for (let bj = 0; bj < N; bj++) {
    // walk ring (sidewalk centrelines) and property lines
    const wx0 = LX[bi] + walkOff(bi), wx1 = LX[bi + 1] - walkOff(bi + 1), wz0 = LZ[bj] + walkOff(bj), wz1 = LZ[bj + 1] - walkOff(bj + 1);
    const px0 = LX[bi] + lotOff(bi), px1 = LX[bi + 1] - lotOff(bi + 1), pz0 = LZ[bj] + lotOff(bj), pz1 = LZ[bj + 1] - lotOff(bj + 1);
    // blocks round the square are downtown; the outer ring is houses, with shops on the arterials
    const ring = Math.max(Math.abs(bi + 0.5 - MID), Math.abs(bj + 0.5 - MID)) - 0.5;
    const zone = ring <= 1 ? 'downtown' : 'res';
    const key = `${bi},${bj}`;

    if (inSquareBlock(bi, bj)) {
      if (bi !== MID - 1 || bj !== MID - 1) continue; // built once, from its north-west block
      // ---- the courthouse square: four blocks of lawn, paths from every corner and side, the courthouse in the middle
      const wx0 = LX[MID - 1] + walkOff(MID - 1), wx1 = LX[MID + 1] - walkOff(MID + 1), wz0 = LZ[MID - 1] + walkOff(MID - 1), wz1 = LZ[MID + 1] - walkOff(MID + 1);
      const px0 = LX[MID - 1] + lotOff(MID - 1), px1 = LX[MID + 1] - lotOff(MID + 1), pz0 = LZ[MID - 1] + lotOff(MID - 1), pz1 = LZ[MID + 1] - lotOff(MID + 1);
      const cx = (px0 + px1) / 2, cz = (pz0 + pz1) / 2;
      parks.push({ k: 'square', p: rect(px0, pz0, px1, pz1) });
      const lx = 27, lz = 26; // the path loop round the building
      sidewalkRing(wx0, wz0, wx1, wz1);
      footway([P2(cx - lx, cz - lz), P2(cx, cz - lz), P2(cx + lx, cz - lz), P2(cx + lx, cz), P2(cx + lx, cz + lz), P2(cx, cz + lz), P2(cx - lx, cz + lz), P2(cx - lx, cz), P2(cx - lx, cz - lz)], 4);
      footway([P2(cx, wz0), P2(cx, cz - lz)], 5);
      footway([P2(cx, wz1), P2(cx, cz + lz)], 5);
      footway([P2(wx0, cz), P2(cx - lx, cz)], 4);
      footway([P2(wx1, cz), P2(cx + lx, cz)], 4);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) footway([P2(sx > 0 ? wx1 : wx0, sz > 0 ? wz1 : wz0), P2(cx + sx * lx, cz + sz * lz)], 3.2);
      // the walk up to each portico
      footway([P2(cx, cz - lz), P2(cx, cz - 21.5)], 8);
      footway([P2(cx, cz + lz), P2(cx, cz + 21.5)], 8);
      // a cross-shaped plan: the main hall with an entrance pavilion on the north and south fronts
      buildings.push({
        t: 'civic', l: 3, h: 0, n: 'Courthouse', a: 40 * 26 + 2 * 16 * 6,
        p: [[-20, -13], [-8, -13], [-8, -19], [8, -19], [8, -13], [20, -13], [20, 13], [8, 13], [8, 19], [-8, 19], [-8, 13], [-20, 13]].map(([x, z]) => P2(cx + x, cz + z)),
      });
      // two rings of trees, and benches by the paths
      for (const r of [38, 70]) {
        for (let t = -r; t <= r; t += 10) {
          for (const s of [-1, 1]) {
            const nearAxis = Math.abs(t) < 6;
            const nearDiag = Math.abs(Math.abs(t) - r) < 7;
            if (nearAxis || nearDiag) continue;
            trees.push(P2(cx + t, cz + s * r));
            trees.push(P2(cx + s * r, cz + t));
          }
        }
      }
      for (const s of [-1, 1]) for (const t of [-14, 14]) {
        benches.push(P2(cx + t, cz + s * (lz + 3)));
        benches.push(P2(cx + s * (lx + 3), cz + t));
      }
      continue;
    }

    const parkKind = PARK_BLOCKS.get(key);
    if (key === GROCERY_BLOCK) {
      sidewalkRing(wx0, wz0, wx1, wz1);
      grocery(px0, pz0, px1, pz1);
      continue;
    }
    if (GAS_CORNERS.has(key)) gasStation(px0, pz0, px1, pz1, GAS_CORNERS.get(key));
    if (bj === RIVER_ROW) {
      // ---- river blocks: lots on the north and south banks, a riverwalk along each quay
      const n = [wx0, wx1].map((x) => bankN(x) - RIVERWALK), s = [wx0, wx1].map((x) => bankS(x) + RIVERWALK);
      sidewalkRing(wx0, wz0, wx1, wz1, { n: [], s: [], e: [bankN(wx1) - RIVERWALK, bankS(wx1) + RIVERWALK], w: [bankN(wx0) - RIVERWALK, bankS(wx0) + RIVERWALK] });
      void n, s;
      for (const side of [-1, 1]) {
        const pts = [];
        for (let x = wx0; x < wx1; x += 6) pts.push(P2(x, side < 0 ? bankN(x) - RIVERWALK : bankS(x) + RIVERWALK));
        pts.push(P2(wx1, side < 0 ? bankN(wx1) - RIVERWALK : bankS(wx1) + RIVERWALK));
        footway(pts, 3.4, '', { n: 'Riverwalk' });
        for (let x = wx0 + 20; x < wx1 - 15; x += 26) benches.push(P2(x, side < 0 ? bankN(x) - RIVERWALK - 2.2 : bankS(x) + RIVERWALK + 2.2));
      }
      if (parkKind) {
        parks.push({ k: parkKind, p: [...[px0, px1].map((x) => P2(x, pz0)), P2(px1, bankN(px1) - RIVERWALK - 2), P2(px0, bankN(px0) - RIVERWALK - 2)] });
        parks.push({ k: parkKind, p: [P2(px0, bankS(px0) + RIVERWALK + 2), P2(px1, bankS(px1) + RIVERWALK + 2), P2(px1, pz1), P2(px0, pz1)] });
        continue;
      }
      const room = 6.5;
      lotFace({ x0: px0, x1: px1, front: pz0, dir: 1, depthAt: (x) => bankN(x) - RIVERWALK - room - pz0, zone, arterial: ARTERIAL.has(bj), alley: null, ring });
      lotFace({ x0: px0, x1: px1, front: pz1, dir: -1, depthAt: (x) => pz1 - (bankS(x) + RIVERWALK + room), zone, arterial: ARTERIAL.has(bj + 1), alley: null, ring });
      continue;
    }

    if (parkKind) {
      // ---- a park block: paths from the corners and the middle of every side to a central plaza
      sidewalkRing(wx0, wz0, wx1, wz1);
      parks.push({ k: parkKind, p: rect(px0, pz0, px1, pz1) });
      if (parkKind !== 'pitch') {
        const cx = (wx0 + wx1) / 2, cz = (wz0 + wz1) / 2;
        const hub = [P2(cx - 6, cz - 6), P2(cx + 6, cz - 6), P2(cx + 6, cz + 6), P2(cx - 6, cz + 6), P2(cx - 6, cz - 6)];
        footway(hub, 3.4);
        footway([P2(cx, wz0), P2(cx, cz - 6)], 3);
        footway([P2(cx, wz1), P2(cx, cz + 6)], 3);
        footway([P2(wx0, cz), P2(cx - 6, cz)], 3);
        footway([P2(wx1, cz), P2(cx + 6, cz)], 3);
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) footway([P2(sx > 0 ? wx1 : wx0, sz > 0 ? wz1 : wz0), P2(cx + sx * 6, cz + sz * 6)], 2.6);
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) benches.push(P2(cx + sx * 9, cz + sz * 3), P2(cx + sx * 3, cz + sz * 9));
        if (parkKind === 'lawn') {
          for (let k = 0; k < 70; k++) {
            const x = between(px0 + 4, px1 - 4), z = between(pz0 + 4, pz1 - 4);
            const onPath = Math.abs(x - cx) < 4 || Math.abs(z - cz) < 4 || Math.abs(Math.abs(x - cx) - Math.abs(z - cz) * ((wx1 - wx0) / (wz1 - wz0))) < 4 || (Math.abs(x - cx) < 10 && Math.abs(z - cz) < 10);
            if (!onPath) trees.push(P2(x, z));
          }
        }
      }
      continue;
    }

    // ---- an ordinary block: lots facing the north and south streets, an alley down the middle
    sidewalkRing(wx0, wz0, wx1, wz1);
    const zA = (LZ[bj] + LZ[bj + 1]) / 2;
    road('alley', '', ALLEY_W, [P2(LX[bi] + widthOf(bi) / 2 - 0.5, zA), P2(LX[bi + 1] - widthOf(bi + 1) / 2 + 0.5, zA)]);
    const halfRoom = 0.6 + ALLEY_W / 2;
    lotFace({ x0: px0, x1: px1, front: pz0, dir: 1, depthAt: () => zA - halfRoom - pz0, zone, arterial: ARTERIAL.has(bj), alley: zA, ring });
    lotFace({ x0: px0, x1: px1, front: pz1, dir: -1, depthAt: () => pz1 - (zA + halfRoom), zone, arterial: ARTERIAL.has(bj + 1), alley: zA, ring });
  }
}

// ---- crosswalks: kerb to kerb at every junction leg, with a short apron from the sidewalk corner to the kerb
for (let i = 0; i <= N; i++) {
  for (let j = 0; j <= N; j++) {
    const zebra = big(i) && big(j) ? 1 : 0;
    // across the N-S street i, on the north and south sides of E-W street j
    if (i > 0 && i < N) {
      for (const [z, ok] of [[LZ[j] - walkOff(j), j > 0], [LZ[j] + walkOff(j), j < N]]) {
        if (!ok) continue;
        const a = LX[i] - widthOf(i) / 2, b = LX[i] + widthOf(i) / 2;
        if (inSquare(LX[i], z)) continue;
        footway([P2(a, z), P2(b, z)], 2.6, 'crossing', { zb: zebra });
        footway([P2(LX[i] - walkOff(i), z), P2(a, z)], WALK_W, 'link');
        footway([P2(b, z), P2(LX[i] + walkOff(i), z)], WALK_W, 'link');
      }
    }
    // across the E-W street j, on the west and east sides of N-S street i
    if (j > 0 && j < N) {
      for (const [x, ok] of [[LX[i] - walkOff(i), i > 0], [LX[i] + walkOff(i), i < N]]) {
        if (!ok) continue;
        const a = LZ[j] - widthOf(j) / 2, b = LZ[j] + widthOf(j) / 2;
        if (inSquare(x, LZ[j])) continue;
        footway([P2(x, a), P2(x, b)], 2.6, 'crossing', { zb: zebra });
        footway([P2(x, LZ[j] - walkOff(j)), P2(x, a)], WALK_W, 'link');
        footway([P2(x, b), P2(x, LZ[j] + walkOff(j))], WALK_W, 'link');
      }
    }
  }
}
for (const c of roads.filter((r) => r.f === 'crossing')) crossings.push(c.p[0]);

// the banks, sampled every 2 m across the map plus exactly at every bridge edge, for the bank mesh: [x, north z, south z]
const riverBanks = (() => {
  const xs = new Set();
  for (let x = X0; x < X1; x += 2) xs.add(r2(x));
  xs.add(r2(X1));
  LX.forEach((lx, i) => { xs.add(r2(lx - BRIDGE_HALF(i))); xs.add(r2(lx + BRIDGE_HALF(i))); });
  return [...xs].sort((a, b) => a - b).map((x) => [x, r2(bankN(x)), r2(bankS(x))]);
})();

// ------------------------------------------------------------------ terrain
// A shallow valley: flat along the river, rising a few metres toward the edges, with a gentle roll. The river
// channel is cut below the bank, only well inside the water so the land beside the quay stays level.
const STEP = 6;
const NX = Math.ceil((X1 - X0) / STEP) + 1, NZ = Math.ceil((Z1 - Z0) / STEP) + 1;
const smooth = (a, b, v) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const heights = new Float64Array(NX * NZ);
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const x = X0 + i * STEP, z = Z0 + j * STEP;
    const d = Math.abs(z - riverZ(x));
    const lift = smooth(RIVER_HALF + 40, RIVER_HALF + 600, d);
    let h = lift * (5.5 + 1.4 * Math.sin(x / 230 + 1.1) * Math.cos(z / 190) + 0.7 * Math.sin((x + z) / 120));
    // deep water: only where every surrounding grid cell is water, so bilinear slopes stay under the quay walls
    const inner = RIVER_HALF - 8.7;
    if (d < RIVER_HALF) {
      if (d < inner && !onBridge(x, 8.7)) h = RIVER_FLOOR;
      else h = 0;
    }
    heights[j * NX + i] = h;
  }
}
let hMin = Infinity;
for (const h of heights) hMin = Math.min(hMin, h);

const out = {
  name: NAME,
  center: [0, 0],
  scale: 1,
  extent: r2(Math.max(-X0, X1, -Z0, Z1)),
  bounds: { x0: r2(X0), x1: r2(X1), z0: r2(Z0), z1: r2(Z1) },
  lakeIdx: -1,
  osmCopyright: '',
  heights: { nx: NX, nz: NZ, step: STEP, min: r2(hMin), data: Array.from(heights, (h) => Math.round((h - hMin) * 100)) }, // centimetres above the lowest point
  river: { bank: r2(-hMin), water: r2(RIVER_WATER - hMin), floor: r2(RIVER_FLOOR - hMin), name: 'Rat River', banks: riverBanks },
  bridges,
  stations,
  courthouse: { x: 0, z: 0 },
  stores,
  roads, buildings, rails, parks, water, signals, crossings, lamps: [], trees, hydrants: [], benches, bins: [], shops,
};
fs.mkdirSync('public/city', { recursive: true });
fs.writeFileSync(`public/city/${NAME}.json`, JSON.stringify(out));
const kb = Math.round(fs.statSync(`public/city/${NAME}.json`).size / 1024);
const count = (t) => buildings.filter((b) => b.t === t).length;
console.log(JSON.stringify({ stores: stores.map((st) => st.kind).join(','), roads: roads.length, footways: roads.filter((r) => r.k === 'footway').length, buildings: buildings.length, garages: count('garage'), shops: shops.length, parks: parks.length, water: water.length, bridges: bridges.length, trees: trees.length, grid: `${NX}x${NZ}`, kb }));
