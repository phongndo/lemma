import { IMAGE_TYPES, MAX_IMAGE_BYTES } from "@lemma/llm";
import type { ImageContent } from "@lemma/llm";

/** A file as attaching sorts it: its MIME type (`""` when the browser knows none) and size. */
export interface FileLike {
  readonly type: string;
  readonly size: number;
}

/**
 * Files given to attach, sorted: the images providers take (`accepted`), and why the rest are left out. A file of no
 * type the browser knows (an image with an unusual extension, say) is told it is not a format taken, not that it is no
 * image.
 */
export const sortFiles = <F extends FileLike>(files: readonly F[]) => {
  const supported = files.filter((file) => IMAGE_TYPES.has(file.type));
  const accepted = supported.filter((file) => file.size <= MAX_IMAGE_BYTES);
  const others = files.filter((file) => file.type !== "" && !file.type.startsWith("image/")).length;
  return { accepted, others, unsupported: files.length - others - supported.length, tooLarge: supported.length - accepted.length };
};

/** The warnings for the files `sortFiles` left out, one per reason. */
export const leftOutWarnings = (sorted: { readonly others: number; readonly unsupported: number; readonly tooLarge: number }): readonly string[] => {
  const { others, unsupported, tooLarge } = sorted;
  return [
    ...(others > 0 ? [`${others === 1 ? "A file was" : `${others} files were`} not attached: only images can be.`] : []),
    ...(unsupported > 0 ? [`${unsupported === 1 ? "An image was" : `${unsupported} images were`} not attached: use PNG, JPEG, GIF, or WebP.`] : []),
    ...(tooLarge > 0 ? [`${tooLarge === 1 ? "An image was" : `${tooLarge} images were`} not attached: over the 3.75 MB limit providers accept.`] : []),
  ];
};

/** The warning for images that could not be read (gone from a network share, say). */
export const unreadWarning = (unread: number): string =>
  `${unread === 1 ? "An image" : `${unread} images`} could not be read, and ${unread === 1 ? "was" : "were"} not attached.`;

export const readImage = (file: File): Promise<ImageContent> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ type: "image", mimeType: file.type, data: url.slice(url.indexOf(",") + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
    reader.readAsDataURL(file);
  });
