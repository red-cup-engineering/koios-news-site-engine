/**
 * Raster icons drawn from the same two seeds as the SVG favicon (accent square,
 * ink monogram), so favicon.ico and apple-touch-icon.png always match
 * favicon.svg. Pure and deterministic: a supersampled polygon fill encoded as a
 * PNG, with no font engine or image library. The monogram is drawn for the
 * letters this masthead family uses; any other initial gets a plain ink block
 * so the icon still exists and still carries the accent.
 */
import { crc32, deflateSync } from "node:zlib";

const SUPERSAMPLE = 4;
// Unit-square outlines. A stroke is the quad around a segment, `half` either side.
const stroke = ([x1, y1], [x2, y2], half) => {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const nx = (-(y2 - y1) / length) * half;
  const ny = ((x2 - x1) / length) * half;
  return [[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]];
};
const GLYPHS = Object.freeze({
  K: [
    [[0.27, 0.20], [0.40, 0.20], [0.40, 0.80], [0.27, 0.80]],
    stroke([0.36, 0.56], [0.78, 0.18], 0.075),
    stroke([0.48, 0.45], [0.80, 0.82], 0.075),
  ],
});
const BLOCK = [[[0.30, 0.30], [0.70, 0.30], [0.70, 0.70], [0.30, 0.70]]];

function hexColor(value, fallback) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(String(value ?? "").trim());
  if (!match) return fallback;
  const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
  return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16));
}

const inside = (polygon, x, y) => {
  let hit = false;
  for (let from = 0, to = polygon.length - 1; from < polygon.length; to = from, from += 1) {
    const [x1, y1] = polygon[from];
    const [x2, y2] = polygon[to];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) hit = !hit;
  }
  return hit;
};

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * @param {number} size pixels per side
 * @param {{name:string}} property
 * @param {{accent:string,ink:string}} seeds
 * @returns {Buffer} an opaque RGB PNG
 */
export function renderIconPng(size, property, seeds) {
  const accent = hexColor(seeds.accent, [209, 26, 26]);
  const ink = hexColor(seeds.ink, [18, 18, 18]);
  const initial = (property.name.trim()[0] ?? "N").toUpperCase();
  const polygons = GLYPHS[initial] ?? BLOCK;
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    const row = y * (stride + 1);
    for (let x = 0; x < size; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = (x + (sx + 0.5) / SUPERSAMPLE) / size;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) / size;
          if (polygons.some((polygon) => inside(polygon, px, py))) covered += 1;
        }
      }
      const weight = covered / samples;
      for (let channel = 0; channel < 3; channel += 1) {
        raw[row + 1 + x * 3 + channel] = Math.round(accent[channel] * (1 - weight) + ink[channel] * weight);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A one-image ICO whose payload is the PNG (supported by every current browser). */
export function renderFaviconIco(property, seeds, size = 48) {
  const png = renderIconPng(size, property, seeds);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = size;
  header[7] = size;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

/** The 180-pixel icon iOS uses for home-screen shortcuts. */
export const renderAppleTouchIcon = (property, seeds) => renderIconPng(180, property, seeds);
