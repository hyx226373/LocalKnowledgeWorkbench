/** 布局品牌标：圆角矩形里的单字母 K。颜色走令牌，方便暗色包换色。 */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg data-testid="brand-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ width: size, height: size, flex: 'none' }}>
      <rect width="24" height="24" rx="6" fill="var(--kb-color-accent)" />
      <path d="M8 6.8v10.4M8 12h5.1a3.2 3.2 0 0 0 0-6.4H8M8 12l5.8 5.2" fill="none" stroke="var(--kb-color-accent-fg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
