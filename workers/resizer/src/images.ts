/**
 * Image resizing behind one method so tests can fake it. The real
 * implementation is the Cloudflare Images binding (billed per unique
 * source-and-parameters pair per month); outputs are cached by the handler.
 *
 * The output is read whole before it is returned: with many cold resizes of
 * large sources in flight at once, the binding's stream can end early, and a
 * 200 with a short body shows as a broken image and leaves nothing useful in
 * the edge cache. A whole buffer is checked against the length the binding
 * declared and either answers and caches completely or throws TransformFailed
 * for the handler to retry.
 */
import type { MediaOutputMime } from '@photonrelic/media-params';

export interface TransformOptions {
  width: number;
  height?: number;
  fit: 'scale-down' | 'cover';
  format: MediaOutputMime;
  /**
   * The point a cover crop keeps, as fractions of the source's width and
   * height from the top-left (the library's focal point). Unset, the binding
   * picks the crop itself (gravity auto). Meaningless for scale-down.
   */
  gravity?: { x: number; y: number };
}

export interface TransformResult {
  /** The whole encoded image; a 2,048-pixel copy is a few megabytes at most. */
  body: ArrayBuffer;
  contentType: string;
}

/** The binding failed or delivered fewer bytes than it declared; the caller may retry. */
export class TransformFailed extends Error {
  override readonly name = 'TransformFailed';
}

export interface ImageTransformer {
  transform(input: ReadableStream | ArrayBuffer, opts: TransformOptions): Promise<TransformResult>;
}

export class CloudflareImageTransformer implements ImageTransformer {
  constructor(private readonly images: ImagesBinding) {}

  async transform(
    input: ReadableStream | ArrayBuffer,
    opts: TransformOptions,
  ): Promise<TransformResult> {
    const stream = input instanceof ArrayBuffer ? new Blob([input]).stream() : input;
    // The binding's type wants a `mode` beside the coordinates, which the
    // Images docs give only for `fit: crop`; a cover crop takes the bare
    // `{x, y}` fractions the docs show, so the point is asserted past it.
    type Gravity = NonNullable<ImageTransform['gravity']>;
    const gravity: Gravity = opts.gravity
      ? ({ x: opts.gravity.x, y: opts.gravity.y } as Gravity)
      : 'auto';
    const transform: ImageTransform = { width: opts.width, fit: opts.fit, gravity };
    if (opts.height !== undefined) transform.height = opts.height;
    let res: Response;
    let body: ArrayBuffer;
    try {
      const result = await this.images
        .input(stream as ReadableStream<Uint8Array>)
        .transform(transform)
        .output({ format: opts.format });
      res = result.response();
      body = await res.arrayBuffer();
    } catch (e) {
      throw new TransformFailed(`resizer failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0 && body.byteLength !== declared) {
      throw new TransformFailed(`resizer sent ${body.byteLength} of ${declared} bytes`);
    }
    if (body.byteLength === 0) throw new TransformFailed('resizer sent an empty body');
    return { body, contentType: res.headers.get('content-type') ?? opts.format };
  }
}
