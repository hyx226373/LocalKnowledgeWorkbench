import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { kb } from '../kb';
import { KbToggle } from './KbToggle';
import {
  CONTENT_INDEX_SCOPE_KEY,
  DEFAULT_CONTENT_INDEX_MAX_BYTES,
  MAX_CONTENT_INDEX_BYTES,
  OPTIONAL_CONTENT_TYPES,
  defaultContentIndexScope,
  parseContentIndexScope,
  parsePrefixList,
  type ContentIndexScope,
} from '../../shared/contentIndexScope';

function prefixesText(list: string[]): string {
  return list.join('\n');
}

export function ContentIndexScopeSection() {
  const [scope, setScope] = useState<ContentIndexScope>(defaultContentIndexScope);
  const [maxText, setMaxText] = useState(String(DEFAULT_CONTENT_INDEX_MAX_BYTES));
  const [includeText, setIncludeText] = useState('');
  const [excludeText, setExcludeText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void kb.getLayout(CONTENT_INDEX_SCOPE_KEY).then((raw) => {
      if (!alive) return;
      const parsed = parseContentIndexScope(raw);
      setScope(parsed);
      setMaxText(String(parsed.maxBytes));
      setIncludeText(prefixesText(parsed.includePrefixes));
      setExcludeText(prefixesText(parsed.excludePrefixes));
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const writeScope = (next: ContentIndexScope, after?: (stored: ContentIndexScope) => void) => {
    const stored = parseContentIndexScope(next);
    const prev = scope;
    setScope(stored);
    setBusy(true);
    setNote('');
    void kb.setLayout(CONTENT_INDEX_SCOPE_KEY, stored).then(
      () => {
        setNote('已保存');
        after?.(stored);
      },
      (err: unknown) => {
        setScope(prev);
        setNote(String((err as Error)?.message ?? err));
      },
    ).finally(() => setBusy(false));
  };

  const toggleExt = (ext: string, on: boolean) => {
    const extraExtensions = on
      ? [...scope.extraExtensions, ext]
      : scope.extraExtensions.filter((item) => item !== ext);
    writeScope({ ...scope, extraExtensions });
  };

  const saveBounds = () => {
    const n = Number(maxText.trim());
    if (!Number.isInteger(n) || n < 1) {
      setNote('上限须是正整数，单位是字节');
      return;
    }
    const includeRaw = includeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const excludeRaw = excludeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const includePrefixes = parsePrefixList(includeText);
    const excludePrefixes = parsePrefixList(excludeText);
    const dropped = includeRaw.length + excludeRaw.length - includePrefixes.length - excludePrefixes.length;
    const capped = Math.min(n, MAX_CONTENT_INDEX_BYTES);
    writeScope({ ...scope, maxBytes: capped, includePrefixes, excludePrefixes }, (stored) => {
      setMaxText(String(stored.maxBytes));
      setIncludeText(prefixesText(stored.includePrefixes));
      setExcludeText(prefixesText(stored.excludePrefixes));
      if (dropped > 0) setNote('已保存。绝对路径和越出根目录的前缀已忽略');
      else if (capped !== n) setNote(`已保存。上限不超过 ${MAX_CONTENT_INDEX_BYTES} 字节`);
    });
  };

  return (
    <section data-testid="settings-content-index-scope">
      <h2>全文索引范围</h2>
      <p className="kb-set-lead">
        默认只索引文字类文件（Markdown、txt，以及阅读器认作文本的代码和配置）。PDF 可单独勾选。正文范围为主屏幕打开的文件、Agent 资料、Agent 仓库和工作台资料。关闭的标签保留到下次启动。每个文件最多索引前 1 MiB。
        文件夹用根内相对路径前缀，一行一条；排除优先于包含。保存后立即更新范围；范围外仍可按文件名搜索。
      </p>
      {OPTIONAL_CONTENT_TYPES.filter((item) => item.ext === 'pdf').map((item) => (
        <div className="kb-set-row" key={item.ext}>
          <div>
            <b>{item.label}</b>
            <p>纳入全文索引</p>
          </div>
          <KbToggle
            testId={`settings-index-ext-${item.ext}`}
            label={item.label}
            checked={scope.extraExtensions.includes(item.ext)}
            disabled={busy}
            onChange={(on) => toggleExt(item.ext, on)}
          />
        </div>
      ))}
      <label className="kb-field">
        单文件索引上限（字节）
        <input
          data-testid="settings-index-max-bytes"
          value={maxText}
          inputMode="numeric"
          onChange={(e) => setMaxText(e.target.value)}
        />
      </label>
      <label className="kb-field">
        只索引这些文件夹（留空表示不限制）
        <textarea
          className="kb-index-scope-text"
          data-testid="settings-index-include"
          value={includeText}
          rows={3}
          spellCheck={false}
          onChange={(e) => setIncludeText(e.target.value)}
        />
      </label>
      <label className="kb-field">
        排除这些文件夹
        <textarea
          className="kb-index-scope-text"
          data-testid="settings-index-exclude"
          value={excludeText}
          rows={3}
          spellCheck={false}
          onChange={(e) => setExcludeText(e.target.value)}
        />
      </label>
      <button type="button" className="kb-button" data-testid="settings-index-scope-save" disabled={busy} onClick={saveBounds}>
        <Save size={15} strokeWidth={1.5} />保存范围
      </button>
      {note ? <p className="kb-set-status" data-testid="settings-index-scope-note">{note}</p> : null}
    </section>
  );
}
