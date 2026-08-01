// Texture contact sheet — a dev tool, never imported by the game.
//
//   node src/mat/preview.mjs out.png
//
// Renders every generated map to one PNG so the surfaces can be inspected
// directly instead of being inferred from a game frame. This exists because
// four of the names in this directory (stoneCarved, stonePolished,
// marbleDark, marbleLight, clothCape) are not yet on any mesh, so a
// screenshot of the game cannot show them at all — and the two defects that
// cost the most time this session, an inverted normal-map Y and an albedo
// variation that read as terracotta at distance, were both instantly obvious
// in the maps and invisible in prose.
//
// Rows: stone, marble, gold, cloth, track, pave.  Columns: albedo, normal, orm.

import { generateStoneMaps } from './stone.js';
import { generateGoldMaps } from './gold.js';
import { generateClothMaps } from './cloth.js';
import { generateTrackMaps } from './track.js';
import { generatePaveMaps } from './pave.js';
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunks = [];
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    chunks.push(len, td, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunk('IHDR', ihdr);
  chunk('IDAT', zlib.deflateSync(raw));
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), ...chunks]);
}
let T = null;
function crc32(buf) {
  if (!T) { T = new Int32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;T[n]=c;} }
  let c = -1; for (let i=0;i<buf.length;i++) c = T[(c^buf[i])&0xff]^(c>>>8); return c^-1;
}

const S = 256;
const sets = {
  stone: generateStoneMaps(S, 1),
  marble: generateStoneMaps(S, 0),
  gold: generateGoldMaps(S, 10, 1),
  cloth: generateClothMaps(S, 30),
  track: generateTrackMaps(S, 2, 1),
  pave: generatePaveMaps(S, 8),
};
// contact sheet: rows = sets, cols = albedo/normal/orm
const names = Object.keys(sets);
const CH = ['albedo','normal','orm'];
const W = S*3, H = S*names.length;
const out = new Uint8Array(W*H*4);
names.forEach((nm, r) => {
  CH.forEach((ch, c) => {
    const src = sets[nm][ch];
    if (!src) return;
    for (let y=0;y<S;y++) for (let x=0;x<S;x++) {
      const so=(y*S+x)*4, dof=((r*S+y)*W + c*S + x)*4;
      out[dof]=src[so]; out[dof+1]=src[so+1]; out[dof+2]=src[so+2]; out[dof+3]=255;
    }
  });
});
writeFileSync(process.argv[2] || 'maps-preview.png', png(W,H,out));
console.log('rows (top to bottom):', names.join(', '), '| cols: albedo, normal, orm');
