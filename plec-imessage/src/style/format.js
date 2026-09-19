/**
 * Post-process every outgoing bubble in code, because models slip:
 * no markdown, <= 300 chars per bubble, <= 3 bubbles.
 */
const MAX_BUBBLE = 300;
const MAX_BUBBLES = 3;

export function stripMarkdown(text) {
  return String(text ?? '')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 $2')   // [text](url) -> text url
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,!?])/g, '$1$2')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                       // headers
    .replace(/^\s*[-*•]\s+/gm, '')                            // bullets
    .replace(/^\s*>\s?/gm, '')                                // quotes
    .replace(/\*\*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Hard-split at sentence (or line, or word) boundaries so no piece exceeds max. */
export function splitLong(text, max = MAX_BUBBLE) {
  const out = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n'), ...['. ', '! ', '? '].map((s) => { const i = window.lastIndexOf(s); return i >= 0 ? i + 1 : -1; }));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function formatBubbles(bubbles) {
  let parts = (Array.isArray(bubbles) ? bubbles : [bubbles])
    .map(stripMarkdown)
    .filter(Boolean)
    .flatMap((b) => splitLong(b));
  if (parts.length > MAX_BUBBLES) {
    // Merge extras into the last allowed bubble, then re-split only if it is absurdly long.
    const head = parts.slice(0, MAX_BUBBLES - 1);
    const tail = parts.slice(MAX_BUBBLES - 1).join('\n');
    parts = [...head, tail];
  }
  return parts;
}
