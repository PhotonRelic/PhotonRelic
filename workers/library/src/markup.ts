/**
 * The file page's Markup panel: copy-ready `<picture>` or `<img srcset>`
 * markup for a key, built from the resizer's menu. The first rendering is
 * built here, server-side; /static/pr-markup.js rebuilds it in the browser as
 * the choices change, from the same inputs.
 */
import { type MarkupOptions, pictureMarkup, type ResizeMenu } from '@photonrelic/media-params';
import type { AppDeps } from './deps.js';
import type { Asset } from './library.js';

/** Ticked by default: a phone-to-desktop spread, where the menu has these. */
export const DEFAULT_MARKUP_WIDTHS = [480, 768, 1024, 1440] as const;

export interface MarkupPanelModel {
  origin: string;
  key: string;
  /** The asset's default alt text; empty when none has been filed yet. */
  alt: string;
  /** The stored image's pixel size, when the library knows it. */
  width: number | null;
  height: number | null;
  menu: ResizeMenu;
  /** The widths ticked on first rendering. */
  ticked: number[];
  /** The `<picture>` for the ticked widths, no aspect, sizes 100vw. */
  initial: string;
}

/** The defaults that are on the menu, or the whole menu when none is (a short custom menu). */
export function defaultMarkupWidths(menu: ResizeMenu): number[] {
  const on = DEFAULT_MARKUP_WIDTHS.filter((w) => menu.widths.includes(w));
  return on.length ? on : [...menu.widths];
}

/** The panel's model for a key, or null when there is no resizer to embed from. */
export function markupPanel(
  deps: AppDeps,
  key: string,
  asset: Asset | null,
): MarkupPanelModel | null {
  if (!deps.mediaOrigin) return null;
  const ticked = defaultMarkupWidths(deps.menu);
  const alt = asset?.alt_default ?? '';
  const known = asset?.width && asset.height ? { width: asset.width, height: asset.height } : null;
  const o: MarkupOptions = { widths: ticked, alt, ...(known ?? {}) };
  return {
    origin: deps.mediaOrigin,
    key,
    alt,
    width: known?.width ?? null,
    height: known?.height ?? null,
    menu: deps.menu,
    ticked,
    initial: pictureMarkup(deps.mediaOrigin, key, o, deps.menu),
  };
}
