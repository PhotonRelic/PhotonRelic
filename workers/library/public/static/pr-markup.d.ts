/** Types for the markup panel's builder, used by its unit test. The DOM glue is not exported. */
export function mediaUrl(
  origin: string,
  key: string,
  opts?: { w?: number; ar?: string; f?: string },
): string;
export function escapeAttr(s: string): string;
export function srcset(
  origin: string,
  key: string,
  widths: number[],
  opts?: { ar?: string; f?: string },
): string;
export function embedMarkup(
  origin: string,
  key: string,
  opts: {
    kind: 'picture' | 'img';
    widths: number[];
    ar?: string;
    sizes?: string;
    alt: string;
    width?: number;
    height?: number;
  },
): string;
