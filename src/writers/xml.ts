/** Shared by the Traktor and rekordbox XML writers. */

/** Escapes an XML attribute value: & < > " ' become entities; control characters are dropped. */
export function escapeXmlAttr(s: string): string {
  return [...s]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
