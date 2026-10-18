import { CommandError } from '../commands/registry'
import type { UserImageBlock } from './session'

/**
 * Images in the prompt (#83): the guide's "paste images" as `attach-image`
 * reads them off the clipboard. The bytes are kept as PNG in the prompt
 * queue until the prompt is sent, and go out as an image content block
 * next to the text in the same user message. What the prompt, the
 * transcript and the session folder see is the marker line alone: the
 * index, the size in pixels and in kilobytes, never the bytes.
 *
 * Pure data, no Electron: index.ts turns the clipboard's NativeImage into a
 * ClipboardImage, and the unit tests build one from a handful of bytes.
 */

/** An image as read off the clipboard: PNG bytes and its size in pixels. */
export interface ClipboardImage {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
}

/** An image attached to the prompt being composed. */
export interface PromptImage extends ClipboardImage {
  /** 1 for the first image of the prompt. */
  readonly index: number
  /** The line in the prompt that stands for it: `[image 1: 1280x800 png, 240 KB]`. */
  readonly marker: string
}

/** Who reads the clipboard: Electron in production, a stand-in under test. */
export interface ClipboardReader {
  /** The image on the clipboard, or null when it holds none. Electron reads the clipboard asynchronously. */
  readImage(): Promise<ClipboardImage | null>
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_IMAGES_PER_PROMPT = 4

/** Whole kilobytes, at least one, as the marker shows them. */
export function formatKilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** The marker line for the image at `index`. */
export function imageMarker(index: number, image: ClipboardImage): string {
  return `[image ${index}: ${image.width}x${image.height} png, ${formatKilobytes(image.png.byteLength)}]`
}

/** Refuses an image over the cap, with the size in the message. */
export function assertImageFits(image: ClipboardImage): void {
  if (image.png.byteLength > MAX_IMAGE_BYTES) {
    const megabytes = (image.png.byteLength / (1024 * 1024)).toFixed(1)
    throw new CommandError(
      `The image is ${megabytes} MB; an image in the prompt may be ${MAX_IMAGE_BYTES / (1024 * 1024)} MB at most`,
    )
  }
}

/** The content block the SDK takes, next to the text of the same message. */
export function imageBlock(image: ClipboardImage): UserImageBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from(image.png).toString('base64'),
    },
  }
}
