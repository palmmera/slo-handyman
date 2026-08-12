// Creates a transparent-background version of the logo.
// The logo sits on a solid rectangle (white or black), but the badge itself also
// contains those colors (outlines, banner, house, text). So we flood-fill ONLY
// from the outer edges and stop at the badge's border — this removes the
// surrounding background while keeping every pixel inside the artwork.
//
// The background color is auto-detected from the image corners, so this works
// for both light- and dark-background logos.
//
// Usage: node scripts/make-transparent-logo.mjs

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "public", "img", "logo.png");
const OUT = path.join(__dirname, "..", "public", "img", "logo-transparent.png");

const THRESHOLD = 46; // how close to the bg color a pixel must be to be removed

const png = PNG.sync.read(fs.readFileSync(SRC));
const { width, height, data } = png;

const idx = (x, y) => (y * width + x) * 4;

// Auto-detect background from the four corners: bright => white bg, else black.
const cornerBrightness = [
  [0, 0],
  [width - 1, 0],
  [0, height - 1],
  [width - 1, height - 1],
].map(([x, y]) => {
  const i = idx(x, y);
  return (data[i] + data[i + 1] + data[i + 2]) / 3;
});
const avgCorner = cornerBrightness.reduce((a, b) => a + b, 0) / 4;
const lightBackground = avgCorner > 128;

const isBg = (x, y) => {
  const i = idx(x, y);
  const r = data[i], g = data[i + 1], b = data[i + 2];
  return lightBackground
    ? Math.min(r, g, b) >= 255 - THRESHOLD // near white
    : Math.max(r, g, b) <= THRESHOLD; // near black
};
const isDark = isBg;
console.log(`Detected ${lightBackground ? "WHITE" : "BLACK"} background.`);

const visited = new Uint8Array(width * height);
const queue = [];

// Seed the flood fill with every dark pixel on the four borders.
for (let x = 0; x < width; x++) {
  if (isDark(x, 0)) queue.push([x, 0]);
  if (isDark(x, height - 1)) queue.push([x, height - 1]);
}
for (let y = 0; y < height; y++) {
  if (isDark(0, y)) queue.push([0, y]);
  if (isDark(width - 1, y)) queue.push([width - 1, y]);
}

let removed = 0;
while (queue.length) {
  const [x, y] = queue.pop();
  if (x < 0 || y < 0 || x >= width || y >= height) continue;
  const p = y * width + x;
  if (visited[p]) continue;
  visited[p] = 1;
  if (!isDark(x, y)) continue; // hit the bright badge border — stop here

  data[idx(x, y) + 3] = 0; // make transparent
  removed++;

  queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
}

fs.writeFileSync(OUT, PNG.sync.write(png));
console.log(
  `Done. Removed ${removed.toLocaleString()} background pixels ` +
    `(${((removed / (width * height)) * 100).toFixed(1)}%). Saved ${OUT}`
);
