import { useEffect, useRef, useState } from 'react';
import type { BlankFileCreated, BlankFileExt } from '../../shared/blankFile';
import { completeBlankFileName } from '../../shared/blankFile';
import type { DirEntry, Root } from '../../shared/types';
import { kb } from '../kb';
import { LoadingLabel } from '../ui/LoadingLabel';
import { ChevronRightIcon, TreeGlyph } from '../ui/shellMarks';

function ipcMessage(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method 'kb': (Error: )?/, '');
}

function folderRootsOf(list: readonly Root[]): Root[] {
  return list.filter((root) => root.kind === 'folder' && root.status === 'ok' && !!root.path && !!root.resourceId);
}

function dirEntries(rows: readonly DirEntry[]): DirEntry[] {
  return rows.filter((entry) => entry.kind === 'dir');
}

function indent(depth: number): string {
  return `calc(var(--kb-space-3) + ${depth} * 14px)`;
}

type FolderChoice = {
  rootId: string;
  relPath: string;
  resourceId: string;
  name: string;
};

function choiceKey(rootId: string, relPath: string): string {
  return `${rootId}\0${relPath}`;
}

function FolderRow({
  depth,
  name,
  title,
  expandable,
  open,
  selected,
  busy,
  rootId,
  relPath,
  kind,
  onToggle,
  onSelect,
}: {
  depth: number;
  name: string;
  title: string;
  expandable: boolean;
  open: boolean;
  selected: boolean;
  busy: boolean;
  rootId: string;
  relPath: string;
  kind: 'root' | 'dir';
  onToggle: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      className="kb-tree-row"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={expandable ? open : undefined}
      aria-selected={selected ? 'true' : 'false'}
      data-testid="new-file-folder-row"
      data-kind={kind}
      data-root-id={rootId}
      data-relpath={relPath}
      data-depth={depth}
      title={title}
      style={{ paddingLeft: indent(depth) }}
    >
      {expandable ? (
        <button
          type="button"
          className="kb-new-file-expand"
          data-testid="new-file-folder-expand"
          data-root-id={rootId}
          data-relpath={relPath}
          aria-expanded={open}
          aria-label={`${open ? '收起' : '展开'} ${name}`}
          disabled={busy}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggle();
          }}
        >
          <span className={'kb-chev' + (open ? ' open' : '')} aria-hidden="true">
            <ChevronRightIcon width={14} height={14} />
          </span>
        </button>
      ) : (
        <span className="kb-new-file-expand" aria-hidden="true" />
      )}
      <button
        type="button"
        className="kb-new-file-name"
        data-testid="new-file-folder-name"
        data-root-id={rootId}
        data-relpath={relPath}
        disabled={busy}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect();
        }}
      >
        <TreeGlyph kind={kind === 'root' ? 'root' : 'dir'} open={expandable && open} />
        <span className="name">{name}</span>
      </button>
    </div>
  );
}

function FolderLevel({
  rootId,
  relPath,
  depth,
  busy,
  selectedKey,
  onSelect,
}: {
  rootId: string;
  relPath: string;
  depth: number;
  busy: boolean;
  selectedKey: string;
  onSelect: (choice: FolderChoice) => void;
}) {
  const [items, setItems] = useState<DirEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    setItems(null);
    setErr(null);
    kb.listDir(rootId, relPath).then(
      (rows) => {
        if (stop) return;
        setItems(dirEntries(rows));
        setErr(null);
      },
      (error) => {
        if (stop) return;
        setErr(ipcMessage(error));
      },
    );
    return () => {
      stop = true;
    };
  }, [rootId, relPath]);
  if (err) {
    return (
      <div className="kb-error" data-testid="new-file-folder-error" data-root-id={rootId} data-relpath={relPath}>
        无法读取：{err}
      </div>
    );
  }
  if (!items) {
    return (
      <div style={{ paddingLeft: indent(depth) }}>
        <LoadingLabel testId="new-file-folder-loading" />
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div
        className="kb-tree-row empty"
        data-testid="new-file-folder-empty"
        data-root-id={rootId}
        data-relpath={relPath}
        style={{ paddingLeft: indent(depth) }}
      >
        （无子文件夹）
      </div>
    );
  }
  return (
    <div data-testid="new-file-folder-children" data-root-id={rootId} data-relpath={relPath}>
      {items.map((entry) => (
        <FolderNode
          key={entry.resourceId || `${entry.rootId}:${entry.relPath}`}
          entry={entry}
          depth={depth}
          busy={busy}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function FolderNode({
  entry,
  depth,
  busy,
  selectedKey,
  onSelect,
}: {
  entry: DirEntry;
  depth: number;
  busy: boolean;
  selectedKey: string;
  onSelect: (choice: FolderChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <FolderRow
        depth={depth}
        name={entry.name}
        title={entry.relPath}
        expandable
        open={open}
        selected={selectedKey === choiceKey(entry.rootId, entry.relPath)}
        busy={busy}
        rootId={entry.rootId}
        relPath={entry.relPath}
        kind="dir"
        onToggle={() => setOpen((value) => !value)}
        onSelect={() => onSelect({
          rootId: entry.rootId,
          relPath: entry.relPath,
          resourceId: entry.resourceId,
          name: entry.name,
        })}
      />
      {open ? (
        <FolderLevel
          rootId={entry.rootId}
          relPath={entry.relPath}
          depth={depth + 1}
          busy={busy}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      ) : null}
    </>
  );
}

function RootBranch({
  root,
  busy,
  selectedKey,
  onSelect,
}: {
  root: Root;
  busy: boolean;
  selectedKey: string;
  onSelect: (choice: FolderChoice) => void;
}) {
  return (
    <div data-testid="new-file-root-block" data-root-id={root.id}>
      <FolderRow
        depth={0}
        name={root.name}
        title={root.path}
        expandable={false}
        open={false}
        selected={selectedKey === choiceKey(root.id, '')}
        busy={busy}
        rootId={root.id}
        relPath=""
        kind="root"
        onToggle={() => undefined}
        onSelect={() => onSelect({
          rootId: root.id,
          relPath: '',
          resourceId: root.resourceId,
          name: root.name,
        })}
      />
      <FolderLevel rootId={root.id} relPath="" depth={1} busy={busy} selectedKey={selectedKey} onSelect={onSelect} />
    </div>
  );
}

/**
 * 「新建文件…」下面的抽屉。只列已注册文件夹根里现有的文件夹。
 * 打开时每个根只请求第一层；展开箭头才请求下一层。点名称选中，不展开。
 */
export function NewFileDrawer({
  roots,
  onCancel,
  onCreated,
  title,
  submitText,
  initialName,
  fixedExt,
  hint,
  onSubmit,
}: {
  roots?: Root[];
  onCancel: () => void;
  onCreated?: (created: BlankFileCreated) => void;
  title?: string;
  submitText?: string;
  initialName?: string;
  fixedExt?: BlankFileExt;
  hint?: string | ((preview: string, alt: string) => string);
  onSubmit?: (input: { dir: string; name: string; ext: BlankFileExt }) => Promise<BlankFileCreated | void>;
}) {
  const pickSeq = useRef(0);
  const [loaded, setLoaded] = useState<Root[] | null>(roots ?? null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [choice, setChoice] = useState<FolderChoice | null>(null);
  const [abs, setAbs] = useState('');
  const [name, setName] = useState(initialName ?? '');
  const [ext, setExt] = useState<BlankFileExt>(fixedExt ?? 'md');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (roots) {
      setLoaded(roots);
      setLoadErr(null);
      return;
    }
    let stop = false;
    setLoaded(null);
    kb.listRoots().then(
      (list) => {
        if (!stop) setLoaded(list);
      },
      (error) => {
        if (!stop) setLoadErr(ipcMessage(error));
      },
    );
    return () => {
      stop = true;
    };
  }, [roots]);

  let preview = '';
  let nameError = '';
  if (name.trim()) {
    try {
      preview = completeBlankFileName(name, ext).fileName;
    } catch (error) {
      nameError = (error as Error).message;
    }
  }
  const alt = preview ? preview.replace(/(\.[^.]+)$/, '(2)$1') : `名字(2).${ext}`;
  const folderRoots = loaded ? folderRootsOf(loaded) : [];
  const selectedKey = choice ? choiceKey(choice.rootId, choice.relPath) : '';
  const dirShown = abs || (choice ? (choice.relPath || choice.name) : '');

  const select = (next: FolderChoice) => {
    if (busy) return;
    const seq = ++pickSeq.current;
    setChoice(next);
    setAbs('');
    setErr(null);
    if (!next.resourceId) {
      setErr('这个文件夹还不能使用，请稍后再试');
      return;
    }
    void kb.resourceAbsPath(next.resourceId).then(
      (path) => {
        if (seq !== pickSeq.current) return;
        const trimmed = String(path ?? '').trim();
        if (!trimmed) {
          setErr('无法定位文件夹');
          return;
        }
        setAbs(trimmed);
      },
      (error) => {
        if (seq !== pickSeq.current) return;
        setErr(ipcMessage(error));
      },
    );
  };

  const submit = async () => {
    if (busy) return;
    if (!abs.trim()) {
      setErr('请选择文件夹');
      return;
    }
    if (nameError) {
      setErr(nameError);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (onSubmit) {
        const created = await onSubmit({ dir: abs.trim(), name, ext });
        if (created && onCreated) onCreated(created);
      } else {
        const created = await kb.createBlankFile({ dir: abs.trim(), name, ext });
        onCreated?.(created);
      }
    } catch (error) {
      setErr(ipcMessage(error));
      setBusy(false);
    }
  };

  return (
    <div
      id="new-file-drawer"
      className="kb-new-file-drawer"
      data-testid="new-file-drawer"
      role="group"
      aria-label={title ?? '新建文件'}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      {loadErr ? <div className="kb-error" data-testid="new-file-folder-error">{loadErr}</div> : null}
      {!loaded && !loadErr ? <LoadingLabel testId="new-file-folder-loading" /> : null}
      {loaded ? (
        <div className="kb-new-file-tree" role="tree" aria-label="目标文件夹" data-testid="new-file-folder-tree">
          {folderRoots.length === 0 ? (
            <p data-testid="new-file-folder-none">还没有已注册的文件夹。请先添加一个根目录。</p>
          ) : folderRoots.map((root) => (
            <RootBranch key={root.id} root={root} busy={busy} selectedKey={selectedKey} onSelect={select} />
          ))}
        </div>
      ) : null}
      <div className="kb-new-file-form" data-testid="new-file-body">
        <label>
          目标文件夹
          <input
            className="kb-input"
            readOnly
            value={dirShown}
            placeholder="点选一个文件夹"
            title={abs || '点选一个文件夹'}
            data-testid="new-file-dir"
          />
        </label>
        <label>
          文件名
          <input
            className="kb-input"
            value={name}
            placeholder="例如 笔记"
            data-testid="new-file-name"
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setErr(null);
            }}
          />
        </label>
        <label>
          类型
          <select
            className="kb-select"
            style={{ width: '100%' }}
            data-testid="new-file-ext"
            value={ext}
            disabled={busy || !!fixedExt}
            onChange={(event) => setExt(event.target.value === 'txt' ? 'txt' : 'md')}
          >
            <option value="md">md</option>
            {!fixedExt ? <option value="txt">txt</option> : null}
          </select>
        </label>
        <div className="kb-new-file-hint">
          {typeof hint === 'function'
            ? hint(preview, alt)
            : (hint ?? (preview ? `将创建空白文件「${preview}」。同名则使用「${alt}」，不覆盖，也不写模板。` : '扩展名会自动补上。同名时自动加 (2)，不覆盖已有文件，内容为空。'))}
        </div>
        {nameError ? <div className="kb-error">{nameError}</div> : null}
        {err ? <div className="kb-error" data-testid="new-file-error">{err}</div> : null}
      </div>
      <div className="kb-new-file-actions">
        <button type="button" className="kb-button kb-button--secondary" data-testid="new-file-cancel" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="kb-button"
          data-testid="new-file-ok"
          disabled={busy || !abs.trim() || !name.trim() || !!nameError}
          onClick={() => submit()}
        >
          {submitText ?? '创建'}
        </button>
      </div>
    </div>
  );
}
