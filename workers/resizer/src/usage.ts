/**
 * Usage tracking: one data point per image served, into a Workers Analytics
 * Engine dataset the library reads back to show how often a file is used
 * and which files nothing has asked for in months. Optional: without the
 * binding there is no sink and nothing is written. Only 200s are counted;
 * a 404 or a refused origin is not a use of the image.
 *
 * The index is the key (or its hash when the key is longer than the engine's
 * index cap; see usageIndex), so the engine samples per image at high
 * volume and a count for one key stays meaningful. The blobs repeat the key
 * in full and say how it was served; the doubles count one hit and the
 * bytes when they are known.
 */
import { usageIndex } from '@photonrelic/media-params';

export interface UsagePoint {
  key: string;
  /** As stored, or resized through the Images binding. */
  kind: 'stored' | 'transform';
  /** The resolved output format for a transform (`webp`), the content type as stored. */
  format: string;
  /** Whether the edge cache answered. */
  cache: 'hit' | 'miss';
  /** Bytes in the response body, when the response says. */
  bytes: number | null;
}

export interface UsageSink {
  record(point: UsagePoint): Promise<void>;
}

export class AnalyticsEngineUsageSink implements UsageSink {
  constructor(private readonly dataset: AnalyticsEngineDataset) {}
  async record(p: UsagePoint): Promise<void> {
    this.dataset.writeDataPoint({
      indexes: [usageIndex(p.key)],
      blobs: [p.key, p.kind, p.format, p.cache],
      doubles: p.bytes === null ? [1] : [1, p.bytes],
    });
  }
}
