/**
 * One-shot messages across a redirect, carried in a cookie the next page
 * render consumes. The cookie is scoped to the app and lasts a minute.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export type FlashLevel = 'success' | 'warning' | 'error' | 'info';
export interface Flash {
  level: FlashLevel;
  message: string;
}

const COOKIE = 'pr_flash';

export function setFlash(c: Context, level: FlashLevel, message: string): void {
  const value = btoa(unescape(encodeURIComponent(JSON.stringify({ level, message }))));
  setCookie(c, COOKIE, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    maxAge: 60,
  });
}

export function takeFlash(c: Context): Flash[] {
  const raw = getCookie(c, COOKIE);
  if (!raw) return [];
  deleteCookie(c, COOKIE, { path: '/' });
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(raw)))) as Flash;
    if (parsed && typeof parsed.message === 'string') return [parsed];
  } catch {
    // a malformed cookie is dropped
  }
  return [];
}

/** Redirect after a POST, carrying a flash. */
export function redirectWith(c: Context, to: string, level: FlashLevel, message: string): Response {
  setFlash(c, level, message);
  return c.redirect(to, 303);
}
