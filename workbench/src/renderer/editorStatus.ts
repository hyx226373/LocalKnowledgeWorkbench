/**
 * 打开中的可编辑文档的状态（按资源 id）：编码、换行、是否有未保存修改。
 * - 状态栏显示当前标签文件的编码（星图组 C 项产品决定）；
 * - 从工作区移除资料时，据此判断要关闭的标签有没有未保存内容（先确认）。
 */
import type { TextEncodingName } from '../shared/textEdit';

export interface EditorDocStatus {
  encoding: TextEncodingName;
  eol: 'lf' | 'crlf';
  dirty: boolean;
  editable: boolean;
}

const docs = new Map<string, Map<symbol, EditorDocStatus>>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

export const ENCODING_LABEL: Record<TextEncodingName, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  gb18030: 'GBK/GB18030',
};

export const editorStatus = {
  set(resourceId: string, key: symbol, st: EditorDocStatus) {
    const m = docs.get(resourceId) ?? new Map<symbol, EditorDocStatus>();
    const old = m.get(key);
    if (old && old.encoding === st.encoding && old.eol === st.eol && old.dirty === st.dirty && old.editable === st.editable) return;
    m.set(key, st);
    docs.set(resourceId, m);
    emit();
  },
  remove(resourceId: string, key: symbol) {
    const m = docs.get(resourceId);
    if (!m?.delete(key)) return;
    if (!m.size) docs.delete(resourceId);
    emit();
  },
  get(resourceId: string): EditorDocStatus | undefined {
    const m = docs.get(resourceId);
    if (!m) return undefined;
    const all = [...m.values()];
    return { ...all[0], dirty: all.some((x) => x.dirty) };
  },
  isDirty(resourceId: string): boolean {
    return [...(docs.get(resourceId)?.values() ?? [])].some((x) => x.dirty);
  },
  /** 除指定面板外是否还有未保存（多视图草稿协调，E9） */
  isDirtyExcept(resourceId: string, exceptKey: symbol): boolean {
    return [...(docs.get(resourceId)?.entries() ?? [])].some(([k, x]) => k !== exceptKey && x.dirty);
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  version: () => version,
};
