/**
 * Holds a few images that were asked for ahead of time, so showing one is a cache hit: the browser
 * has fetched it, and `decode()` has turned it into pixels before the `<img>` needs them.
 *
 * It never holds more than `limit` images, and an image that is not wanted any more is dropped at
 * once: clearing `src` cancels a request that has not finished and lets go of the pixels of one
 * that has. The request that is still in the jobs process cannot be recalled, but it only fills a
 * bounded cache.
 */

/** The part of `HTMLImageElement` the preloader uses. */
export interface PreloadImage {
  src: string;
  decoding: 'async' | 'sync' | 'auto';
  decode(): Promise<void>;
}

export class ImagePreloader {
  private readonly held = new Map<string, PreloadImage>();

  constructor(
    private readonly limit: number,
    private readonly create: () => PreloadImage = () => new Image(),
  ) {}

  /** Hold exactly these (the first `limit` of them); drop everything else. */
  want(urls: readonly string[]): void {
    const wanted = new Set(urls.slice(0, this.limit));
    for (const [url, image] of [...this.held]) {
      if (wanted.has(url)) continue;
      image.src = '';
      this.held.delete(url);
    }
    for (const url of wanted) {
      if (this.held.has(url)) continue;
      const image = this.create();
      image.decoding = 'async';
      image.src = url;
      // A failed decode just means it is fetched when it is shown.
      image.decode().catch(() => undefined);
      this.held.set(url, image);
    }
  }

  /** Drop everything that is not in `urls`, and ask for nothing new. */
  keepOnly(urls: readonly string[]): void {
    const keep = new Set(urls);
    for (const [url, image] of [...this.held]) {
      if (keep.has(url)) continue;
      image.src = '';
      this.held.delete(url);
    }
  }

  clear(): void {
    this.keepOnly([]);
  }

  urls(): string[] {
    return [...this.held.keys()];
  }
}
