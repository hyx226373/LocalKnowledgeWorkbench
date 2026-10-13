const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;

/** 长度 n 的汉字串：重叠二字 n-1 个；入库再加 n 个单字，一共 2n-1（n=1 时只有那一个字）。 */
function cjkPieces(run: string, withChars: boolean): string[] {
  if (run.length <= 1) return [run];
  const grams: string[] = [];
  for (let i = 0; i < run.length - 1; i += 1) grams.push(run.slice(i, i + 2));
  if (withChars) {
    for (const ch of run) grams.push(ch);
  }
  return grams;
}

function tokenizeCjk(input: string, withChars: boolean): string {
  const text = input.normalize('NFC');
  return text.replace(CJK_RUN, (run) => ` ${cjkPieces(run, withChars).join(' ')} `);
}

/**
 * 入库切分。连续汉字先写重叠二字，再为每个字写一个单字 token。
 * 查询不要用这个结果拼短语：单字会把二字短语打断。查询走 buildMatchQuery。
 */
export function bigramTokenize(input: string): string {
  return tokenizeCjk(input, true);
}

export function buildMatchQuery(
  raw: string,
  kind: 'trigram' | 'bigram',
  trigramStyle: 'quoted' | 'bare',
): string | null {
  const q = raw.trim().normalize('NFC');
  if (!q) return null;
  if (kind === 'trigram') {
    if ([...q].length < 3) return null;
    if (trigramStyle === 'bare') return q;
    return `"${q.replace(/"/g, '""')}"`;
  }
  // 查询只拿重叠二字；长度为 1 时才用单字。不能把入库用的单字也塞进短语。
  const parts = tokenizeCjk(q, false)
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return `"${parts.map((part) => part.replace(/"/g, '""')).join(' ')}"`;
}
