const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;
/**
 * 与 `@kb/indexer` 的 `bigramTokenize` 相同：连续汉字切成重叠二字，其余原样。
 * indexer 没有导出这个函数，改名时要在本包里用同一套切法。
 */
export function bigramTokenize(input) {
    const text = input.normalize('NFC');
    return text.replace(CJK_RUN, (run) => {
        if (run.length <= 1)
            return ` ${run} `;
        const grams = [];
        for (let i = 0; i < run.length - 1; i += 1) {
            grams.push(run.slice(i, i + 2));
        }
        return ` ${grams.join(' ')} `;
    });
}
/** 与 indexer 写入 fts_short.title 的切法相同：文件名、换行、相对路径，再做重叠二字。 */
export function ftsShortTitle(filename, relPath) {
    return bigramTokenize(`${filename}\n${relPath}`);
}
//# sourceMappingURL=bigram.js.map