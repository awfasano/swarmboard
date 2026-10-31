// A small markdown renderer for board content: headings, paragraphs, lists,
// block quotes, tables, fenced code, emphasis, links and inline code. Math
// ($…$, $$…$$) is left in place for KaTeX to render in the browser.
// Everything is HTML-escaped before any markup is added, so content can never
// inject tags or attributes; only https links are produced.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function inline(src: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  let s = src
    .replace(/`([^`]+)`/g, (_m, code) => hold(`<code>${esc(code)}</code>`))
    .replace(/\$\$([^$]+)\$\$/g, (_m, tex) => hold(`$$${esc(tex)}$$`))
    .replace(/\$([^$\n]+)\$/g, (_m, tex) => hold(`$${esc(tex)}$`));
  s = esc(s)
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, (_m, label, url) => hold(`<a href="${url}" rel="nofollow noopener" target="_blank">${label}</a>`))
    .replace(/(^|[\s(])(https:\/\/[^\s<)]*[^\s<).,;:!?])/g, (_m, pre, url) => `${pre}${hold(`<a href="${url}" rel="nofollow noopener" target="_blank">${url}</a>`)}`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  // Held fragments can contain other placeholders (e.g. math inside a link).
  for (let pass = 0; pass < 4 && s.includes("\u0000"); pass++) s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => held[Number(i)] ?? "");
  return s.replace(/\u0000/g, "");
}

const isTableSep = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map(c => inline(c.trim()));

export function markdown(src: string): string {
  // NUL is reserved for the inline renderer's placeholders.
  const lines = src.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
    } else if (/^\s*\$\$\s*$/.test(line) && lines.slice(i + 1).some(l => /^\s*\$\$\s*$/.test(l))) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*\$\$\s*$/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<div class="math">$$${esc(body.join("\n"))}$$</div>`);
    } else if (/^#{1,4}\s/.test(line)) {
      const level = Math.min(line.match(/^#+/)![0].length + 2, 6);
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ""))}</h${level}>`);
      i++;
    } else if (/^\s*>/.test(line)) {
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) body.push(lines[i].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdown(body.join("\n"))}</blockquote>`);
    } else if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]); i++) {
        let item = lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, "");
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i + 1])) item += " " + lines[++i].trim();
        items.push(`<li>${inline(item)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
    } else if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*>|\s*([-*]|\d+[.)])\s+)/.test(lines[i]) && !(para.length && /^\s*\$\$\s*$/.test(lines[i])); i++) para.push(lines[i]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
    }
  }
  return out.join("\n");
}
