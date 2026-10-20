export interface DomExcerpt {
  id: string;
  text: string;
  occurrence: number;
}

function skipped(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return false;
  return !!parent.closest('.kb-md-toc, .kb-md-backtoc, .kb-mermaid-drawn');
}

function textNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text && !skipped(node)) nodes.push(node);
  }
  return nodes;
}

export function previewPlainText(root: HTMLElement): string {
  return textNodes(root).map((node) => node.data).join('');
}

export function clearDomMarks(root: ParentNode): void {
  const nodes = [...root.querySelectorAll('.kb-agent-mark')];
  for (const node of nodes) {
    const parent = node.parentNode;
    if (!parent) continue;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
    parent.normalize();
  }
}

function wrapRange(nodes: Text[], flatStart: number[], start: number, end: number, id: string): void {
  const hits: { node: Text; localStart: number; localEnd: number }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const from = flatStart[i]!;
    const to = from + node.data.length;
    if (to <= start || from >= end) continue;
    hits.push({
      node,
      localStart: Math.max(0, start - from),
      localEnd: Math.min(node.data.length, end - from),
    });
  }
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]!;
    let target = hit.node;
    if (hit.localEnd < target.data.length) target.splitText(hit.localEnd);
    if (hit.localStart > 0) target = target.splitText(hit.localStart);
    const mark = document.createElement('mark');
    mark.className = 'kb-agent-mark';
    mark.setAttribute('data-agent-mark', id);
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
  }
}

export function applyDomMarks(root: HTMLElement, excerpts: readonly DomExcerpt[]): void {
  clearDomMarks(root);
  for (const excerpt of excerpts) {
    if (!excerpt.text) continue;
    const nodes = textNodes(root);
    const flatStart: number[] = [];
    let cursor = 0;
    const parts: string[] = [];
    for (const node of nodes) {
      flatStart.push(cursor);
      parts.push(node.data);
      cursor += node.data.length;
    }
    const flat = parts.join('');
    let from = 0;
    let seen = 0;
    let at = -1;
    while (from <= flat.length) {
      const found = flat.indexOf(excerpt.text, from);
      if (found < 0) break;
      if (seen === excerpt.occurrence) {
        at = found;
        break;
      }
      seen += 1;
      from = found + excerpt.text.length;
    }
    if (at < 0 && excerpt.occurrence !== 0) {
      const first = flat.indexOf(excerpt.text);
      if (first >= 0 && flat.indexOf(excerpt.text, first + excerpt.text.length) < 0) at = first;
    }
    if (at < 0) continue;
    wrapRange(nodes, flatStart, at, at + excerpt.text.length, excerpt.id);
  }
}
