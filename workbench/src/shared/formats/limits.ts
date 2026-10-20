/** 解析预算。超限直接降级，不把炸弹送进解压或 XML 解析。 */
export const MAX_FORMAT_BYTES = 80 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 8000;
export const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 100;
export const PARSE_TIMEOUT_MS = 10_000;
export const MAX_SHEET_ROWS = 20_000;
export const MAX_SHEET_COLS = 256;
export const MAX_BLOCKS = 8_000;
export const MAX_SLIDES = 500;
export const MAX_PDF_PAGES = 500;
