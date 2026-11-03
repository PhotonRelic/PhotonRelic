/** Types for the uploader's pure half, used by its unit test. The DOM glue is not exported. */
export interface ProposedFile {
  name: string;
  relativePath: string;
  size: number;
  file?: unknown;
}
export interface Proposal {
  file: ProposedFile;
  key: string | null;
  problem: string | null;
}
export function slugifyName(name: string): string;
export function slugifySegment(s: string): string;
export function stripRoot(relativePath: string): string;
export function proposeKeys(
  files: ProposedFile[],
  subject: string,
  opts?: { keepFolders?: boolean; prefix?: string },
): Proposal[];
export function runQueue<T, R>(
  items: T[],
  work: (item: T, attempt: number) => Promise<R>,
  opts?: {
    concurrency?: number;
    retries?: number;
    onState?: (item: T, state: string, attempt: number, error?: unknown) => void;
  },
): Promise<Map<T, { ok: true; value: R } | { ok: false; error: unknown }>>;
export function chunk<T>(list: T[], size: number): T[][];
export function fmtBytes(n: number): string;

/** One file's capture entry: the manifest's, or what the browser read from EXIF. */
export interface CaptureEntry {
  capturedAt?: string;
  camera?: string;
  lens?: string;
  originalWidth?: number;
  originalHeight?: number;
}
export interface DroppedEntry {
  relativePath: string;
  file?: unknown;
}
export const MANIFEST_NAME: string;
export function findManifest<T extends DroppedEntry>(entries: T[]): T | null;
export function matchManifest(
  entries: DroppedEntry[],
  manifestPath: string,
  manifest: unknown,
): Map<string, CaptureEntry>;
/** One file's describe entry: what it said about itself, from the manifest or its own EXIF. */
export interface DescribeEntry {
  title?: string;
  description?: string;
  keywords?: string[];
  creator?: string;
  credit?: string;
  copyright?: string;
  origin?: string;
  sourceUrl?: string;
  usageTerms?: string;
  license?: string;
  masterName?: string;
}
export function matchDescribe(
  entries: DroppedEntry[],
  manifestPath: string,
  manifest: unknown,
): Map<string, DescribeEntry>;
export function captureHeader(entry: CaptureEntry | DescribeEntry): string;
export function readAttribution(bytes: ArrayBuffer | Uint8Array): DescribeEntry;
export function exifDateToIso(s: string): string | null;
export function joinCamera(make: string | null | undefined, model: string | null | undefined): string;
export function readCapture(bytes: ArrayBuffer | Uint8Array): CaptureEntry;
export function webpHasExif(bytes: ArrayBuffer | Uint8Array): boolean;
export function extensionOf(name: string): string;
export function replaceProblem(
  file: { name: string; size: number },
  key: string,
  maxBytes: number,
): string | null;
