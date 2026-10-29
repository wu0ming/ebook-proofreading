'use strict';

// Align paragraphs first, then highlight individual characters in changed passages.
function sequenceDiff(a, b, limit, key = (value) => value) {
  if (a.length * b.length > limit) return [...a.map((value) => ({ type: 'removed', value })), ...b.map((value) => ({ type: 'added', value }))];
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    table[i * width + j] = key(a[i]) === key(b[j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && key(a[i]) === key(b[j])) { out.push({ type: 'same', value: a[i], after: b[j] }); i++; j++; }
    else if (j < b.length && (i === a.length || table[i * width + j + 1] > table[(i + 1) * width + j])) out.push({ type: 'added', value: b[j++] });
    else out.push({ type: 'removed', value: a[i++] });
  }
  return out;
}

function compareText(before, after) {
  const lines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const paragraphs = sequenceDiff(lines(before), lines(after), 1000000, (line) => line.trim());
  const result = [];
  let removed = '', added = '';
  const flush = () => {
    if (removed || added) result.push(...sequenceDiff(Array.from(removed), Array.from(added), 250000));
    removed = ''; added = '';
  };
  for (const item of paragraphs) {
    if (item.type === 'same') { flush(); result.push(...sequenceDiff(Array.from(item.value), Array.from(item.after), 250000)); }
    else if (item.type === 'removed') removed += item.value;
    else added += item.value;
  }
  flush();
  return result.reduce((chunks, item) => {
    const last = chunks[chunks.length - 1];
    if (last && last.type === item.type) last.value += item.value;
    else chunks.push({ type: item.type, value: item.value });
    return chunks;
  }, []);
}

if (typeof module !== 'undefined') module.exports = { compareText };
