import { DOMAIN, type Country } from './types.js';
import { TtlCache } from './cache.js';
import { TokenBucket } from './rate-limit.js';

// Worker-Variante von upstream client/session.ts: globales fetch statt undici, kein Proxy.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface SessionEntry { cookie: string; expiresAt: number }

export interface VintedClientOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  rateLimitPerSec?: number;
  rateLimitBurst?: number;
}

const MAX_RETRY_AFTER_MS = 10_000;

export class VintedClient {
  public readonly proxyUrl?: string = undefined;
  private sessions = new Map<Country, SessionEntry>();
  private sessionTtlMs = 10 * 60 * 1000;
  private cache: TtlCache<string, unknown>;
  private staticCache = new TtlCache<string, unknown>(0, 100);
  private cacheTtlMs: number;
  private bucket: TokenBucket;
  private timeoutMs: number;
  private bootstrapping = new Map<Country, Promise<string>>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(opts: VintedClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.cache = new TtlCache(this.cacheTtlMs);
    this.bucket = new TokenBucket(opts.rateLimitBurst ?? 6, opts.rateLimitPerSec ?? 3);
  }

  private domainFor(country: Country): string {
    if (!Object.hasOwn(DOMAIN, country)) throw new Error(`Unknown country: ${String(country)}`);
    return DOMAIN[country];
  }

  private async bootstrap(country: Country): Promise<{ status: number; cookie: string }> {
    const res = await fetch(`https://${this.domainFor(country)}/catalog`, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });
    await drain(res);
    const setCookies: string[] = (res.headers as any).getSetCookie?.() ?? [];
    const byName = new Map<string, string>();
    for (const raw of setCookies) {
      const head = raw.split(';')[0];
      const eq = head.indexOf('=');
      if (eq <= 0) continue;
      const value = head.slice(eq + 1);
      if (!value) continue; // Vinted schickt erst ein leeres access_token_web, dann das echte
      byName.set(head.slice(0, eq), value);
    }
    return { status: res.status, cookie: [...byName].map(([n, v]) => `${n}=${v}`).join('; ') };
  }

  private async getSessionCookie(country: Country): Promise<string> {
    const cached = this.sessions.get(country);
    if (cached && cached.expiresAt > Date.now()) return cached.cookie;

    let pending = this.bootstrapping.get(country);
    if (!pending) {
      pending = (async () => {
        try {
          const { status, cookie } = await this.bootstrap(country);
          if (!cookie) {
            throw new Error(
              `Vinted bootstrap failed for ${country} (status ${status}). ` +
              `Cloudflare/DataDome may be blocking this Worker's egress IP.`,
            );
          }
          this.sessions.set(country, { cookie, expiresAt: Date.now() + this.sessionTtlMs });
          return cookie;
        } finally {
          this.bootstrapping.delete(country);
        }
      })();
      this.bootstrapping.set(country, pending);
    }
    return pending;
  }

  async fetchHtml(url: string): Promise<{ status: number; body: string }> {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
      },
      redirect: 'follow',
    });
    return { status: res.status, body: await res.text() };
  }

  async apiGet<T = unknown>(country: Country, path: string, overrideTtlMs?: number): Promise<T> {
    return this.cached(country, path, overrideTtlMs, () =>
      this.fetchWithRetry(country, path, 'json', (res) => res.json() as Promise<T>),
    );
  }

  async pageGet<T>(country: Country, path: string, parse: (html: string) => T, overrideTtlMs?: number): Promise<T> {
    return this.cached(country, path, overrideTtlMs, async () =>
      parse(await this.fetchWithRetry(country, path, 'html', (res) => res.text())),
    );
  }

  private async cached<T>(
    country: Country,
    path: string,
    overrideTtlMs: number | undefined,
    load: () => Promise<T>,
  ): Promise<T> {
    this.domainFor(country);
    const ttl = overrideTtlMs ?? this.cacheTtlMs;
    const cache = overrideTtlMs !== undefined ? this.staticCache : this.cache;
    const key = `${country}:${path}`;

    if (ttl > 0) {
      const hit = cache.get(key) as T | undefined;
      if (hit !== undefined) return hit;
      const running = this.inflight.get(key);
      if (running) return running as Promise<T>;
    }
    const run = load().then((value) => {
      if (ttl > 0) cache.set(key, value, ttl);
      return value;
    });
    if (ttl > 0) {
      this.inflight.set(key, run);
      run.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    return run;
  }

  private async fetchWithRetry<T>(
    country: Country,
    path: string,
    kind: 'json' | 'html',
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const domain = this.domainFor(country);
    const url = `https://${domain}${path}`;
    const maxRetries = 3;
    let reauthed = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.bucket.take(country);
      const cookie = await this.getSessionCookie(country);
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: kind === 'json'
          ? {
              'User-Agent': UA,
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'en-US,en;q=0.9',
              'Referer': `https://${domain}/`,
              'Cookie': cookie,
              'X-Requested-With': 'XMLHttpRequest',
              'Sec-Fetch-Dest': 'empty',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
            }
          : {
              'User-Agent': UA,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Referer': `https://${domain}/`,
              'Cookie': cookie,
              'Sec-Fetch-Dest': 'document',
              'Sec-Fetch-Mode': 'navigate',
              'Sec-Fetch-Site': 'same-origin',
            },
      });

      if (res.status === 429 && attempt < maxRetries) {
        await drain(res);
        const retryAfter = Number(res.headers.get('retry-after'));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
          : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        await drain(res);
        if (this.sessions.get(country)?.cookie === cookie) this.sessions.delete(country);
        if (res.status === 401 && !reauthed && attempt < maxRetries) {
          reauthed = true;
          continue;
        }
        throw new Error(
          `Vinted ${res.status} for ${url}. Session/auth rejected, the Worker's egress IP is probably blocked.`,
        );
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Vinted ${res.status} for ${url}: ${body.slice(0, 200)}`);
      }
      return read(res);
    }
    throw new Error(`Vinted 429 for ${url}: rate-limited after ${maxRetries} retries`);
  }
}

async function drain(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* schon geschlossen */ }
}
