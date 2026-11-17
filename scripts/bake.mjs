// Bakes a real place into public/city/<name>.json from OpenStreetMap (Overpass) + Mapzen/AWS terrarium elevation tiles.
//   node scripts/bake.mjs wrigleyville 41.9484 -87.6553 600 [eastMetres] [northMetres]
// northMetres (real metres from the centre) stretches the north edge out (Devon Ave is ~5620 m north of Wrigley).
// Big areas are queried in horizontal bands and merged. OVERPASS=<url> overrides the endpoint list.
// size = side of the square around the centre; eastMetres (real metres) stretches the east edge out to the lake.
// Raw responses are cached in data/ so re-bakes don't hit the APIs again.
import fs from 'node:fs';
import { PNG } from 'pngjs';

const [name = 'wrigleyville', LAT0 = '41.9484', LON0 = '-87.6553', SIZE = '600', EAST = '', NORTH = ''] = process.argv.slice(2);
const lat0 = Number(LAT0), lon0 = Number(LON0), size = Number(SIZE);
const SCALE = 1.25; // world is built 1.25x real size so streets match our 2.6 m doors
const M_LAT = 110574, M_LON = 111320 * Math.cos((lat0 * Math.PI) / 180);
const half = size / 2;
const northM = NORTH ? Number(NORTH) : half; // real metres from the centre to the north edge
const south = lat0 - half / M_LAT, north = lat0 + northM / M_LAT;
const eastM = EAST ? Number(EAST) : half; // real metres from the centre to the east edge
const west = lon0 - half / M_LON, east = lon0 + eastM / M_LON;
const UA = { 'User-Agent': 'rat-game-poc (open-source hobby project)' };

const toXZ = (lat, lon) => [(lon - lon0) * M_LON * SCALE, -(lat - lat0) * M_LAT * SCALE];
const fromXZ = (x, z) => [lat0 - z / SCALE / M_LAT, lon0 + x / SCALE / M_LON];
const r2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------ OpenStreetMap
const ENDPOINTS = process.env.OVERPASS ? [process.env.OVERPASS] : ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function overpass(q, label) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
      if (res.ok) { const t = await res.text(); console.log(label, url, 'bytes', t.length); return t; }
      console.log(`overpass ${res.status} from ${url}`);
    } catch (e) { console.log(`overpass ${url} failed: ${e.cause?.code ?? e.message}`); }
    const wait = 8000 * 2 ** Math.floor(attempt / ENDPOINTS.length);
    console.log(`retry in ${wait / 1000}s (attempt ${attempt + 1}/6)`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error('overpass stayed unavailable');
}
const rawPath = `data/${name}${EAST ? '.e' + EAST : ''}${NORTH ? '.n' + NORTH : ''}.overpass.json`;
let osm;
if (fs.existsSync(rawPath)) {
  osm = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  console.log('using cached', rawPath);
} else {
  const BAND = 450; // real metres of latitude per request
  const nBands = Math.max(1, Math.ceil(((north - south) * M_LAT) / BAND));
  const seen = new Set(), elements = [];
  for (let k = 0; k < nBands; k++) {
    const bs = south + (k * (north - south)) / nBands, bn = south + ((k + 1) * (north - south)) / nBands;
    const bb = `${bs},${west},${bn},${east}`;
    const q = `[out:json][timeout:180];
(
  way["highway"](${bb});
  way["building"](${bb});
  way["railway"~"^(rail|subway|light_rail|narrow_gauge|abandoned|disused)$"](${bb});
  way["leisure"~"^(park|pitch|playground|garden|stadium|sports_centre|track|dog_park)$"](${bb});
  way["natural"~"^(water|wood|scrub)$"](${bb});
  way["landuse"~"^(grass|recreation_ground|cemetery|village_green|forest)$"](${bb});
  way["waterway"](${bb});
  way["natural"~"^(coastline|beach)$"](${bb});
  way["leisure"="beach_resort"](${bb});
  node["highway"~"^(traffic_signals|stop|crossing|street_lamp)$"](${bb});
  node["natural"="tree"](${bb});
  node["amenity"~"^(bench|waste_basket|bicycle_parking|restaurant|cafe|bar|pub|fast_food|bank|pharmacy|ice_cream|fuel|cinema|theatre)$"](${bb});
  node["emergency"="fire_hydrant"](${bb});
  node["shop"](${bb});
);
out geom;`;
    // each finished band is cached, so a failed run resumes at the band that failed (the key includes the box, so a changed box re-fetches)
    const bandFile = `data/bands/${name}.${bb.replaceAll(',', '_')}.json`;
    let part;
    if (fs.existsSync(bandFile)) { part = fs.readFileSync(bandFile, 'utf8'); console.log(`band ${k + 1}/${nBands} cached`); }
    else { part = await overpass(q, `band ${k + 1}/${nBands}`); fs.mkdirSync('data/bands', { recursive: true }); fs.writeFileSync(bandFile, part); }
    for (const e of JSON.parse(part).elements) {
      const id = e.type + e.id;
      if (!seen.has(id)) { seen.add(id); elements.push(e); } // ways crossing a band edge come back twice
    }
  }
  const text = JSON.stringify({ elements });
  fs.writeFileSync(rawPath, text);
  osm = JSON.parse(text);
  console.log('overpass bytes', text.length);
}

// ------------------------------------------------------------------ elevation (terrarium tiles)
const Z = 14;
const n2 = 2 ** Z;
const tileOf = (lat, lon) => {
  const x = ((lon + 180) / 360) * n2;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n2;
  return [x, y];
};
const tiles = new Map();
async function tile(tx, ty) {
  const key = `${tx}/${ty}`;
  if (tiles.has(key)) return tiles.get(key);
  const file = `data/terrarium_${Z}_${tx}_${ty}.png`;
  let buf;
  if (fs.existsSync(file)) buf = fs.readFileSync(file);
  else {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(url + ' ' + res.status);
    buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, buf);
    console.log('tile', key, buf.length, 'bytes');
  }
  const png = PNG.sync.read(buf);
  tiles.set(key, png);
  return png;
}
const texel = async (px, py) => {
  const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
  const png = await tile(tx, ty);
  const x = Math.min(255, Math.max(0, Math.floor(px - tx * 256))), y = Math.min(255, Math.max(0, Math.floor(py - ty * 256)));
  const i = (y * 256 + x) * 4;
  return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
};
const elevAt = async (lat, lon) => {
  const [tx, ty] = tileOf(lat, lon);
  const fx = tx * 256, fy = ty * 256; // tile units -> pixels
  const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5), ax = fx - 0.5 - x0, ay = fy - 0.5 - y0; // bilinear between texel centres
  const [a, b, c, d] = await Promise.all([texel(x0, y0), texel(x0 + 1, y0), texel(x0, y0 + 1), texel(x0 + 1, y0 + 1)]);
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
};

// the area we keep: the bbox plus a margin so nothing is cut off at the edge
const ext = (half + 40) * SCALE;
const X0 = -ext, X1 = (eastM + 40) * SCALE, Z0 = -(northM + 40) * SCALE, Z1 = ext; // world-space bounds of the baked area
const STEP = 6; // metres between height samples (in world units)
const NX = Math.ceil((X1 - X0) / STEP) + 1, NZ = Math.ceil((Z1 - Z0) / STEP) + 1;
console.log('sampling heights', NX, 'x', NZ);
let heights = new Float64Array(NX * NZ);
for (let j = 0; j < NZ; j++) {
  for (let i = 0; i < NX; i++) {
    const [lat, lon] = fromXZ(X0 + i * STEP, Z0 + j * STEP);
    heights[j * NX + i] = await elevAt(lat, lon);
  }
}
// smooth the 30 m-ish source data so it doesn't ripple
for (let pass = 0; pass < 3; pass++) {
  const out = new Float64Array(heights);
  for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
    let s = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += heights[(j + dj) * NX + i + di];
    out[j * NX + i] = s / 9;
  }
  heights = out;
}
let hMin = Infinity, hMax = -Infinity;
for (const h of heights) { hMin = Math.min(hMin, h); hMax = Math.max(hMax, h); }
console.log('elevation', r2(hMin), '->', r2(hMax), 'm (range', r2(hMax - hMin), 'm real)');

// ------------------------------------------------------------------ features
const pts = (geom) => geom.map((g) => toXZ(g.lat, g.lon).map(r2));
const WIDTH = { motorway: 20, trunk: 18, primary: 15, secondary: 13, tertiary: 11.5, unclassified: 9, residential: 9, living_street: 8, service: 4.5, pedestrian: 5, footway: 2, path: 2, cycleway: 2.5, steps: 2, track: 3.5, busway: 7 };
const roads = [], buildings = [], rails = [], parks = [], water = [];
const signals = [], crossings = [], lamps = [], trees = [], hydrants = [], benches = [], bins = [], shops = [];

for (const e of osm.elements) {
  const t = e.tags ?? {};
  if (e.type === 'node') {
    const p = toXZ(e.lat, e.lon).map(r2);
    if (t.highway === 'traffic_signals') signals.push(p);
    else if (t.highway === 'crossing') crossings.push(p);
    else if (t.highway === 'street_lamp') lamps.push(p);
    else if (t.natural === 'tree') trees.push(p);
    else if (t.emergency === 'fire_hydrant') hydrants.push(p);
    else if (t.amenity === 'bench') benches.push(p);
    else if (t.amenity === 'waste_basket') bins.push(p);
    else if (t.shop || t.amenity) shops.push({ p, name: t.name ?? '', kind: t.shop ?? t.amenity });
    continue;
  }
  if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
  const g = pts(e.geometry);
  if (t.natural === 'beach') { parks.push({ k: 'beach', p: g.slice(0, -1) }); continue; }
  if (t.highway) {
    const kind = t.highway.replace('_link', '');
    let width = WIDTH[kind] ?? 6;
    if (t.width && !isNaN(parseFloat(t.width))) width = parseFloat(t.width);
    else if (t.lanes && !isNaN(parseInt(t.lanes))) width = Math.max(width, parseInt(t.lanes) * 3.3);
    const alley = kind === 'service' && (t.service === 'alley' || (!t.name && width <= 5));
    roads.push({ k: alley ? 'alley' : kind, n: t.name ?? '', w: r2(width * SCALE), o: t.oneway === 'yes' ? 1 : 0, br: t.bridge && t.bridge !== 'no' ? 1 : 0, tu: t.tunnel && t.tunnel !== 'no' ? 1 : 0, sw: t.sidewalk ?? '', f: t.footway ?? '', p: g });
  } else if (t.building) {
    if (g.length < 4) continue;
    const ring = g.slice(0, -1);
    let area = 0;
    for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; area += a[0] * b[1] - b[0] * a[1]; }
    area /= 2;
    if (Math.abs(area) < 14) continue;
    if (area < 0) ring.reverse(); // want a consistent winding
    const levels = parseFloat(t['building:levels']);
    const height = parseFloat(t.height);
    buildings.push({ t: t.building, l: isNaN(levels) ? 0 : levels, h: isNaN(height) ? 0 : r2(height * SCALE), n: t.name ?? '', a: r2(Math.abs(area)), p: ring });
  } else if (t.railway) {
    rails.push({ k: t.railway, el: t.bridge && t.bridge !== 'no' || parseInt(t.layer ?? '0') > 0 ? 1 : 0, p: g });
  } else if (t.natural === 'water' || t.waterway) {
    if (t.natural === 'water' && g.length > 3) water.push(g.slice(0, -1));
  } else if (t.leisure || t.landuse || t.natural) {
    if (g.length > 3) parks.push({ k: t.leisure ?? t.landuse ?? t.natural, p: g.slice(0, -1) });
  }
}

// Lake Michigan and the harbours are multipolygon relations (their member ways carry no tags), so ask for them
// separately. `out geom(bbox)` clips the outlines to the box: nulls mark nodes outside it.
const lakePath = `data/${name}${NORTH ? '.n' + NORTH : ''}.lake.json`;
let rels;
if (fs.existsSync(lakePath)) rels = JSON.parse(fs.readFileSync(lakePath, 'utf8'));
else {
  const bb2 = `${south},${west},${north},${east}`;
  const q2 = `[out:json][timeout:90];\nrel["natural"="water"](${bb2});\nout geom(${bb2});`;
  const text = await overpass(q2, 'lake');
  fs.writeFileSync(lakePath, text);
  rels = JSON.parse(text);
}
// An outline is split over many member ways once the box is big (the lake shore inside the Devon box is 7 ways,
// one of them running the other way). Join them end to end before using them: each piece on its own is not a shore.
const stitch = (chains) => {
  const same = (a, b) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;
  const left = chains.map((c) => c.slice());
  const out = [];
  while (left.length) {
    let cur = left.shift();
    for (let grew = true; grew; ) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const c = left[i];
        if (same(cur.at(-1), c[0])) cur = cur.concat(c.slice(1));
        else if (same(cur.at(-1), c.at(-1))) cur = cur.concat(c.slice(0, -1).reverse());
        else if (same(cur[0], c.at(-1))) cur = c.slice(0, -1).concat(cur);
        else if (same(cur[0], c[0])) cur = c.slice(1).reverse().concat(cur);
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    out.push(cur);
  }
  return out;
};
let lakeIdx = -1;
for (const rel of rels.elements ?? []) {
  const isLake = rel.tags?.name === 'Lake Michigan';
  const pieces = (rel.members ?? [])
    .filter((m) => m.role === 'outer')
    .map((m) => (m.geometry ?? []).filter(Boolean).map((q) => toXZ(q.lat, q.lon).map(r2)))
    .filter((c) => c.length >= 2);
  const chains = stitch(pieces).filter((c) => c.length >= 3);
  if (isLake) {
    if (!chains.length) continue;
    const chain = chains.reduce((a, b) => (b.length > a.length ? b : a)); // the shore that crosses the box
    if (chains.length > 1) console.log(`lake: ${chains.length} separate shore pieces, using the longest`);
    if (chain[0][1] > chain.at(-1)[1]) chain.reverse(); // north (small z) -> south
    // run the ends straight out to the edges of the baked area, then close the polygon along the east side.
    // The direction comes from a point ~30 m in, so a couple of close-together end nodes can't fling it sideways.
    const lean = (chainEnd, inward, zt) => {
      const b = chainEnd;
      let a = inward[0];
      for (const q of inward) { a = q; if (Math.hypot(q[0] - b[0], q[1] - b[1]) > 30) break; }
      const dz = b[1] - a[1] || 1;
      return [r2(b[0] + ((b[0] - a[0]) / dz) * (zt - b[1])), zt];
    };
    const n = chain.length;
    const poly = [lean(chain[0], chain.slice(1), Z0 - 20), ...chain, lean(chain[n - 1], chain.slice(0, -1).reverse(), Z1 + 20), [X1 + 40, Z1 + 20], [X1 + 40, Z0 - 20]];
    lakeIdx = water.length;
    water.push(poly);
    console.log('lake shore x', Math.round(Math.min(...chain.map((q) => q[0]))), '..', Math.round(Math.max(...chain.map((q) => q[0]))));
  } else for (const c of chains) water.push(c); // harbour basin: just close it
}
if (lakeIdx < 0) console.log('NO lake outline found');

const out = {
  name, center: [lat0, lon0], scale: SCALE, extent: r2(ext), bounds: { x0: r2(X0), x1: r2(X1), z0: r2(Z0), z1: r2(Z1) }, lakeIdx, osmCopyright: '© OpenStreetMap contributors (ODbL)', elevation: 'Mapzen/AWS terrain tiles (public domain sources)',
  heights: { nx: NX, nz: NZ, step: STEP, min: r2(hMin * SCALE), data: Array.from(heights, (h) => Math.round((h - hMin) * SCALE * 100)) }, // centimetres above the lowest point
  roads, buildings, rails, parks, water, signals, crossings, lamps, trees, hydrants, benches, bins, shops,
};
fs.writeFileSync(`public/city/${name}.json`, JSON.stringify(out));
const stat = fs.statSync(`public/city/${name}.json`).size;
console.log(JSON.stringify({ roads: roads.length, alleys: roads.filter((r) => r.k === 'alley').length, buildings: buildings.length, rails: rails.length, parks: parks.length, water: water.length, signals: signals.length, crossings: crossings.length, lamps: lamps.length, trees: trees.length, hydrants: hydrants.length, shops: shops.length, benches: benches.length, bins: bins.length, jsonKB: Math.round(stat / 1024) }));
