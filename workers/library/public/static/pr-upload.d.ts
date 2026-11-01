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
