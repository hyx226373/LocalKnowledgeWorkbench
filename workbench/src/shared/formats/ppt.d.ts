declare module 'ppt' {
  interface PptParsed {
    docs: Array<{ slideList?: string[] }>;
    slides: unknown[];
  }
  interface PptModule {
    parse_pptcfb(container: unknown, opts?: unknown): PptParsed;
    utils: { to_text(pres: PptParsed): string[] };
  }
  const ppt: PptModule;
  export = ppt;
}
