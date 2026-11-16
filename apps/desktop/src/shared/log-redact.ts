const REDACTED = '[redacted]';

/** `scheme://user:password@host`: everything before the last `@` of the authority is dropped. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
/** `password=...`, `"passphrase": "..."`, `token: ...`. The value runs to a quote, comma or space. */
const KEY_VALUE =
  /(\b(?:pass(?:word|wd|phrase)?|secret|token|api[-_]?key|private[-_]?key)\b["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
const AUTHORIZATION = /\b(authorization\s*:\s*(?:basic|bearer)\s+)\S+/gi;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/**
 * Removes credential material from text that is about to be written to the log file.
 *
 * Two layers: the secret values the app has handled (so a password is caught wherever it turns up,
 * whatever words surround it) and the shapes credentials take in text (a URL with a user and
 * password, `password=…`, an Authorization header, a PEM private key).
 */
export class LogRedactor {
  private values: string[] = [];

  /** Remember secret values. Empty strings are ignored. */
  addSecrets(secrets: Iterable<string | undefined>): void {
    const known = new Set(this.values);
    for (const value of secrets) {
      if (typeof value === 'string' && value.length > 0) known.add(value);
    }
    // Longest first, so a key that contains another value is replaced whole.
    this.values = [...known].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let result = text;
    for (const value of this.values) result = result.split(value).join(REDACTED);
    return result
      .replace(PRIVATE_KEY_BLOCK, REDACTED)
      .replace(URL_USERINFO, `$1${REDACTED}@`)
      .replace(AUTHORIZATION, `$1${REDACTED}`)
      .replace(KEY_VALUE, `$1${REDACTED}`);
  }
}
