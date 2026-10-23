const isBlank = (line) => !line.trim();
const isHeading = (line) => /^ {0,3}#{1,6}\s/.test(line) || /^ {0,3}#{1,6}$/.test(line);
const isFenceStart = (line) => /^ {0,3}(`{3,}|~{3,})/.test(line);
const isHr = (line) => /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
const isQuote = (line) => /^ {0,3}>/.test(line);
const isListItem = (line) => /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/.test(line) || /^ {0,3}\[[ xX]\]\s+/.test(line);
const isIndented = (line) => line.startsWith("  ") || line.startsWith("	");
const isTableDelimiter = (line) => /^ {0,3}\|?(?:\s*:?-{1,}:?\s*\|)+[\s:|-]*$/.test(line) || /^ {0,3}\|?-{1,}[^|]*\|[\s:|-]*$/.test(line);
const hasPipe = (line) => line.includes("|");
const isHtmlBlockStart = (line) => /^ {0,3}<\/?(div|details|summary|center|figure|figcaption|table|img|video|audio|iframe|kbd|sub|sup|mark|span|section|article|aside|br|style|script)\b/i.test(line);
const isListContinuation = (line) => isListItem(line) || isIndented(line);
function parseBlocks(doc) {
  if (!doc) return [];
  const lines = doc.split("\n");
  const blocks = [];
  const lineStart = new Array(lines.length);
  let pos = 0;
  for (let i2 = 0; i2 < lines.length; i2++) {
    lineStart[i2] = pos;
    pos += lines[i2].length + 1;
  }
  const endOf = (i2) => lineStart[i2] + lines[i2].length;
  const docEnd = doc.length;
  let i = 0;
  if (lines.length && lines[0] === "---") {
    let end = -1;
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === "---" || lines[j] === "...") {
        end = j;
        break;
      }
    }
    if (end > 0) {
      blocks.push({ from: 0, to: Math.min(endOf(end), docEnd), type: "meta", text: lines.slice(0, end + 1).join("\n") });
      i = end + 1;
    }
  }
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const start = lineStart[i];
    if (isFenceStart(line)) {
      const markerChar = line.trim()[0];
      const markerLen = line.trim().match(/^(`{3,}|~{3,})/)[0].length;
      const info = line.trim().slice(markerLen).trim();
      let j = i + 1;
      while (j < lines.length) {
        const t = lines[j].trim();
        if (t[0] === markerChar && t.match(new RegExp(`^\\${markerChar}{${markerLen},}\\s*$`))) break;
        j++;
      }
      const closeTo = j < lines.length ? endOf(j) : docEnd;
      blocks.push({ from: start, to: Math.min(closeTo, docEnd), type: "fence", text: lines.slice(i, Math.min(j + 1, lines.length)).join("\n"), info });
      i = j + 1;
      continue;
    }
    if (/^ {0,3}\$\$/.test(line)) {
      if (/\$\$\s*$/.test(line) && line.trim().length > 4) {
        blocks.push({ from: start, to: Math.min(endOf(i), docEnd), type: "math", text: line });
        i++;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && !/^ {0,3}\$\$\s*$/.test(lines[j])) j++;
      if (j >= lines.length) {
        blocks.push({ from: start, to: docEnd, type: "math", text: lines.slice(i).join("\n") });
        i = lines.length;
        continue;
      }
      const closeTo = endOf(j);
      blocks.push({ from: start, to: Math.min(closeTo, docEnd), type: "math", text: lines.slice(i, j + 1).join("\n") });
      i = j + 1;
      continue;
    }
    if (isHeading(line)) {
      const m = /^ {0,3}(#{1,6})/.exec(line);
      blocks.push({ from: start, to: Math.min(endOf(i), docEnd), type: "heading", text: line, level: m[1].length });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push({ from: start, to: Math.min(endOf(i), docEnd), type: "hr", text: line });
      i++;
      continue;
    }
    if (hasPipe(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && (hasPipe(lines[j]) || isTableDelimiter(lines[j]))) j++;
      blocks.push({ from: start, to: Math.min(endOf(j - 1), docEnd), type: "table", text: lines.slice(i, j).join("\n") });
      i = j;
      continue;
    }
    if (isQuote(line)) {
      let j = i + 1;
      while (j < lines.length) {
        if (isQuote(lines[j])) {
          j++;
          continue;
        }
        if (isBlank(lines[j]) && j + 1 < lines.length && isQuote(lines[j + 1])) {
          j++;
          continue;
        }
        break;
      }
      blocks.push({ from: start, to: Math.min(endOf(j - 1), docEnd), type: "quote", text: lines.slice(i, j).join("\n") });
      i = j;
      continue;
    }
    if (isListItem(line)) {
      let j = i + 1;
      while (j < lines.length) {
        if (isListContinuation(lines[j])) {
          j++;
          continue;
        }
        if (isBlank(lines[j])) {
          let k = j;
          while (k < lines.length && isBlank(lines[k])) k++;
          if (k < lines.length && (isListItem(lines[k]) || isIndented(lines[k]) && !isBlank(lines[k]))) {
            j = k;
            continue;
          }
          break;
        }
        break;
      }
      blocks.push({ from: start, to: Math.min(endOf(j - 1), docEnd), type: "list", text: lines.slice(i, j).join("\n") });
      i = j;
      continue;
    }
    if (isHtmlBlockStart(line)) {
      let j = i;
      while (j < lines.length && !isBlank(lines[j])) j++;
      if (j === i) j = i + 1;
      blocks.push({ from: start, to: Math.min(endOf(j - 1), docEnd), type: "html", text: lines.slice(i, j).join("\n") });
      i = j;
      continue;
    }
    {
      let j = i + 1;
      while (j < lines.length && !isBlank(lines[j]) && !isHeading(lines[j]) && !isFenceStart(lines[j]) && !isQuote(lines[j]) && !isListItem(lines[j]) && !isHr(lines[j]) && !/^ {0,3}\$\$/.test(lines[j]) && !isHtmlBlockStart(lines[j]) && !(hasPipe(lines[j]) && j + 1 < lines.length && isTableDelimiter(lines[j + 1]))) j++;
      blocks.push({ from: start, to: Math.min(endOf(j - 1), docEnd), type: "paragraph", text: lines.slice(i, j).join("\n") });
      i = j;
    }
  }
  return blocks;
}
function blockAt(blocks, pos) {
  for (const b of blocks) {
    if (pos >= b.from && pos <= b.to) return b;
  }
  return null;
}
export {
  blockAt,
  parseBlocks
};
