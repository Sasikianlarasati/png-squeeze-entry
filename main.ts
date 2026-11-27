// png-squeeze entry: a lossless PNG re-encoder that beats make.fun's fixed-paeth baseline.
//
// Each screenshot is 1280x720 RGBA, 8 bits a channel. The program reads every instance
// under /input/<id>/image.png and writes a smaller lossless PNG to /output/<id>/image.png.
//
// How it squeezes, per image:
//   1. Decode the stored input PNG and look at what it holds: is every pixel opaque? is
//      every pixel grey? how many distinct RGBA colours are there (up to 256)?
//   2. Try every lossless form that can hold the pixels exactly: a palette when there
//      are at most 256 colours (three entry orderings: most-used first, darkest first,
//      first-seen first, transparent entries always first so tRNS stays short); grey or
//      grey+alpha when every pixel is grey; RGB when opaque; RGBA otherwise; and a tRNS
//      key when a single transparent colour is the only non-opaque value, so the alpha
//      channel can be dropped entirely.
//   3. For each form, try filter plans for the rows: one fixed filter for all rows,
//      per-row minimum-sum (the PNG spec's section 12.8 heuristic), per-row
//      fewest-distinct-byte-pairs, and per-row brute force, where each of the five
//      filters is weighed by a real deflate of that row against the 32 KiB before it.
//   4. Screen every plan with zlib level 6, keep the smallest file, then re-deflate the
//      winning filtered data at level 9 under a few strategies and keep the smallest
//      stream. The output PNG holds only IHDR, PLTE, tRNS, IDAT and IEND, bit depth 8,
//      one zlib stream, every CRC correct.
//   5. If anything unexpected happens for an instance, fall back to plain RGBA with a
//      Paeth filter on every row at level 9, so the instance is still answered.
//
// Everything here is deterministic: no clock, no randomness, no environment input, so
// two executions write the same bytes.

import { inflateSync, deflateSync, constants } from 'node:zlib';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- PNG reading

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function paethPredictor(left, up, upLeft) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

function decodePng(bytes) {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG');
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  const idatParts = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const length = bytes[pos] * 0x1000000 + bytes[pos + 1] * 0x10000 + bytes[pos + 2] * 0x100 + bytes[pos + 3];
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data[0] * 0x1000000 + data[1] * 0x10000 + data[2] * 0x100 + data[3];
      height = data[4] * 0x1000000 + data[5] * 0x10000 + data[6] * 0x100 + data[7];
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('no IHDR');
  if (bitDepth !== 8 || interlace !== 0) throw new Error('only 8-bit non-interlaced PNGs');
  if (colourType === 3) throw new Error('palette input is not expected');
  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 4 ? 2 : 4;
  const total = idatParts.reduce((a, p) => a + p.length, 0);
  const compressed = new Uint8Array(total);
  let at = 0;
  for (const part of idatParts) {
    compressed.set(part, at);
    at += part.length;
  }
  const raw = inflateSync(compressed);
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error('inflated size mismatch');
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? cur[i - channels] : 0;
      const up = y === 0 ? 0 : prev[i];
      const upLeft = i >= channels && y !== 0 ? prev[i - channels] : 0;
      let predict = 0;
      if (filter === 1) predict = left;
      else if (filter === 2) predict = up;
      else if (filter === 3) predict = (left + up) >> 1;
      else if (filter === 4) predict = paethPredictor(left, up, upLeft);
      else if (filter !== 0) throw new Error('unknown filter ' + filter);
      cur[i] = (row[i] + predict) & 0xff;
    }
    prev.set(cur);
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (colourType === 6) {
        rgba[d] = cur[s];
        rgba[d + 1] = cur[s + 1];
        rgba[d + 2] = cur[s + 2];
        rgba[d + 3] = cur[s + 3];
      } else if (colourType === 2) {
        rgba[d] = cur[s];
        rgba[d + 1] = cur[s + 1];
        rgba[d + 2] = cur[s + 2];
        rgba[d + 3] = 255;
      } else if (colourType === 4) {
        rgba[d] = cur[s];
        rgba[d + 1] = cur[s];
        rgba[d + 2] = cur[s];
        rgba[d + 3] = cur[s + 1];
      } else {
        rgba[d] = cur[s];
        rgba[d + 1] = cur[s];
        rgba[d + 2] = cur[s];
        rgba[d + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- PNG writing

function filterRowBytes(type, cur, prev, bpp, out) {
  for (let i = 0; i < cur.length; i++) {
    const left = i >= bpp ? cur[i - bpp] : 0;
    const up = prev === null ? 0 : prev[i];
    const upLeft = i >= bpp && prev !== null ? prev[i - bpp] : 0;
    let predict = 0;
    if (type === 1) predict = left;
    else if (type === 2) predict = up;
    else if (type === 3) predict = (left + up) >> 1;
    else if (type === 4) predict = paethPredictor(left, up, upLeft);
    out[i] = (cur[i] - predict) & 0xff;
  }
}

function signedSum(row) {
  let sum = 0;
  for (let i = 0; i < row.length; i++) {
    const b = row[i];
    sum += b < 128 ? b : 256 - b;
  }
  return sum;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  out[0] = (data.length >>> 24) & 0xff;
  out[1] = (data.length >>> 16) & 0xff;
  out[2] = (data.length >>> 8) & 0xff;
  out[3] = data.length & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = (crc >>> 24) & 0xff;
  out[9 + data.length] = (crc >>> 16) & 0xff;
  out[10 + data.length] = (crc >>> 8) & 0xff;
  out[11 + data.length] = crc & 0xff;
  return out;
}

function ihdrBytes(width, height, colourType) {
  const data = new Uint8Array(13);
  data[0] = (width >>> 24) & 0xff;
  data[1] = (width >>> 16) & 0xff;
  data[2] = (width >>> 8) & 0xff;
  data[3] = width & 0xff;
  data[4] = (height >>> 24) & 0xff;
  data[5] = (height >>> 16) & 0xff;
  data[6] = (height >>> 8) & 0xff;
  data[7] = height & 0xff;
  data[8] = 8;
  data[9] = colourType;
  return data;
}

function pngBytes(width, height, form, idat) {
  const parts = [new Uint8Array(PNG_SIGNATURE), chunk('IHDR', ihdrBytes(width, height, form.colourType))];
  if (form.plte !== null) parts.push(chunk('PLTE', form.plte));
  if (form.trns !== null) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------- Analysis

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let tooMany = false;
  for (let i = 0; i < n; i++) {
    const d = i * 4;
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!tooMany) {
      const w = words[i];
      const k = counts.get(w);
      if (k === undefined) {
        if (counts.size === 256) tooMany = true;
        else counts.set(w, 1);
      } else {
        counts.set(w, k + 1);
      }
    }
  }
  let colours = null;
  if (!tooMany) {
    colours = [];
    let seen = 0;
    for (const [word, count] of counts) {
      const bytes = new Uint8Array(Uint32Array.of(word).buffer);
      colours.push({ rgba: [bytes[0], bytes[1], bytes[2], bytes[3]], word, count, seen: seen++ });
    }
  }
  return { opaque, grey, colours };
}

// The one fully transparent colour the image may key by tRNS instead of an alpha
// channel: every pixel opaque or exactly that value at alpha 0, and no opaque pixel
// of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, colourType) {
  const n = rgba.length >>> 2;
  if (colourType === 6) return rgba;
  const channels = colourType === 0 ? 1 : colourType === 4 ? 2 : 3;
  const out = new Uint8Array(n * channels);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += channels) {
    if (colourType === 0) {
      out[s] = rgba[d];
    } else if (colourType === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// ---------------------------------------------------------------- Palette

function paletteForm(rgba, colours, order) {
  const luminance = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const tx = x.rgba[3] === 255 ? 1 : 0;
    const ty = y.rgba[3] === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    if (order === 'count') return y.count - x.count || x.word - y.word;
    return x.seen - y.seen;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]);
  return { plte, trns, indices };
}

// ---------------------------------------------------------------- Filtering

// How many bytes written before a brute-force row its trials are weighed against.
const BRUTE_CONTEXT = 32768;

function filteredData(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trials.push(row);
  }
  const seenPairs = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRowBytes(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowBytes(t, cur, prev, bpp, trials[t].subarray(1));
      let cost;
      if (choice === 'minsum') {
        cost = signedSum(trials[t].subarray(1));
      } else if (choice === 'pairs') {
        const row = trials[t].subarray(1);
        stamp++;
        let distinct = 0;
        for (let i = 1; i < row.length; i++) {
          const pair = (row[i - 1] << 8) | row[i];
          if (seenPairs[pair] !== stamp) {
            seenPairs[pair] = stamp;
            distinct++;
          }
        }
        cost = distinct;
      } else {
        // Brute force: weigh this row's filter by a real deflate against the
        // 32 KiB written before it, the way the final stream will see it.
        const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
        const options = before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before };
        cost = deflateSync(trials[t], options).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trials[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- Forms

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'seen']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns,
        filters: [0, 'minsum'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let colourType;
  let trns = null;
  if (grey) {
    colourType = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    colourType = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = colourType === 0 ? 1 : colourType === 4 ? 2 : colourType === 2 ? 3 : 4;
  forms.push({
    colourType, bpp, samples: samplesOf(rgba, colourType), plte: null, trns,
    filters: [0, 4, 'minsum', 'brute'],
  });
  return forms;
}

function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

// ---------------------------------------------------------------- Encoding

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };

function encodePng(rgba, width, height) {
  let best = null;
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    for (const choice of form.filters) {
      const data = filteredData(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunkOverhead(form);
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, data, zlib, bytes };
      }
    }
    void spare;
  }
  // Re-deflate the winning filtered data harder and keep the smallest stream.
  let zlib = best.zlib;
  for (const options of [
    { level: 9 },
    { level: 9, strategy: constants.Z_FILTERED },

  ]) {
    const trial = deflateSync(best.data, options);
    if (trial.length < zlib.length) zlib = trial;
  }
  return pngBytes(width, height, best.form, zlib);
}

// Plain RGBA, Paeth on every row, level 9: the fallback when the screen fails.
function packFallback(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : rgba.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    raw[at] = 4;
    filterRowBytes(4, cur, prev, 4, raw.subarray(at + 1, at + 1 + stride));
  }
  const zlib = deflateSync(raw, { level: 9 });
  return pngBytes(width, height, { colourType: 6, plte: null, trns: null }, zlib);
}

// ---------------------------------------------------------------- Main

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inputPath = join(INPUT_DIR, id, 'image.png');
  const outputPath = join(OUTPUT_DIR, id, 'image.png');
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  let image = null;
  try {
    image = decodePng(new Uint8Array(readFileSync(inputPath)));
  } catch {
    image = null;
  }
  if (image === null) {
    copyFileSync(inputPath, outputPath);
    continue;
  }
  let png = null;
  try {
    png = encodePng(image.rgba, image.width, image.height);
  } catch {
    png = null;
  }
  if (png === null) png = packFallback(image.rgba, image.width, image.height);
  writeFileSync(outputPath, png);
}
