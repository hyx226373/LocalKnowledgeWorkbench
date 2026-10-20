import { BUILTIN_FORMAT } from '../../shared/rebirthFormat';

/** 格式说明默认折叠。全文仍在 DOM 里，展开后才显示。 */
export function FormatHint({ text }: { text: string }) {
  return (
    <details className="rb-format-fold">
      <summary>
        <span>格式：默认六块</span>
        <span className="rb-format-tags">
          {(BUILTIN_FORMAT.blocks ?? []).map((block) => (
            <span key={block.type} className="rb-format-tag">{block.title}</span>
          ))}
        </span>
        <span className="rb-format-expand">展开说明</span>
      </summary>
      <p className="rb-format">{text}</p>
    </details>
  );
}
