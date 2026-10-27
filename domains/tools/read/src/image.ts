import jpeg from "jpeg-js";
import { PNG } from "pngjs";

/** The longest side an image is scaled to first: what providers read best (Anthropic scales larger ones down itself). */
const MAX_SIDE = 2000;
const QUALITY = 80;
/** How many smaller sizes are tried, each three quarters of the last, before giving up. */
const TRIES = 6;

interface Pixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, a byte a channel. */
  readonly data: Uint8Array;
}

/** PNG or JPEG decoded, in pure JavaScript: a GIF or WebP is not, and nothing else is an image `read` knows. */
const decode = (bytes: Buffer, mimeType: string): Pixels | undefined => {
  if (mimeType === "image/png") return PNG.sync.read(bytes);
  if (mimeType === "image/jpeg") return jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
  return undefined;
};

/** `image` scaled down to `width` × `height`, each pixel the average of those it covers, on white where it is transparent. */
function scaled(image: Pixels, width: number, height: number): Pixels {
  const data = new Uint8Array(width * height * 4);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const at = (yy * image.width + xx) * 4;
          const alpha = image.data[at + 3]! / 255;
          r += image.data[at]! * alpha + 255 * (1 - alpha);
          g += image.data[at + 1]! * alpha + 255 * (1 - alpha);
          b += image.data[at + 2]! * alpha + 255 * (1 - alpha);
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (y * width + x) * 4;
      data[to] = r / count;
      data[to + 1] = g / count;
      data[to + 2] = b / count;
      data[to + 3] = 255;
    }
  }
  return { width, height, data };
}

/**
 * A PNG or JPEG too large to attach, made one that fits in `maxBytes`: scaled to at most 2000 pixels a side, then
 * smaller until it fits, as a JPEG. Undefined for a GIF or WebP, which it cannot decode, or one that does not fit even
 * small.
 */
export function fitImage(
  bytes: Buffer,
  mimeType: string,
  maxBytes: number,
): { readonly data: Buffer; readonly mimeType: "image/jpeg"; readonly width: number; readonly height: number; readonly from: string } | undefined {
  const image = decode(bytes, mimeType);
  if (image === undefined) return undefined;
  let scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  for (let tries = 0; tries < TRIES; tries++, scale *= 0.75) {
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const data = jpeg.encode(scaled(image, width, height), QUALITY).data;
    if (data.length <= maxBytes) return { data, mimeType: "image/jpeg", width, height, from: `${image.width}x${image.height}` };
  }
  return undefined;
}
