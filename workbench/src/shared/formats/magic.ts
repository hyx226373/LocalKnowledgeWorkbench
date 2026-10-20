export type ContainerKind = 'zip' | 'ole' | 'pdf' | 'rtf' | 'unknown';
export type OfficeFamily = 'word' | 'sheet' | 'slide';

function isRtf(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  if (i + 5 > bytes.length || bytes[i] !== 0x7b || bytes[i + 1] !== 0x5c) return false;
  const lower = (value: number) => (value >= 0x41 && value <= 0x5a ? value + 0x20 : value);
  return lower(bytes[i + 2]) === 0x72 && lower(bytes[i + 3]) === 0x74 && lower(bytes[i + 4]) === 0x66;
}

export function sniff(bytes: Uint8Array): ContainerKind {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    if ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08)) return 'zip';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0 &&
    bytes[4] === 0xa1 &&
    bytes[5] === 0xb1 &&
    bytes[6] === 0x1a &&
    bytes[7] === 0xe1
  ) {
    return 'ole';
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) return 'pdf';
  if (isRtf(bytes)) return 'rtf';
  return 'unknown';
}

export function familyOfExt(ext: string): OfficeFamily | 'pdf' | null {
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'docx':
    case 'wps':
      return 'word';
    case 'xlsx':
    case 'et':
      return 'sheet';
    case 'pptx':
    case 'dps':
      return 'slide';
    case 'pdf':
      return 'pdf';
    default:
      return null;
  }
}

export function familyFromContentTypes(xml: string): OfficeFamily | null {
  const text = xml.toLowerCase();
  if (text.includes('wordprocessingml')) return 'word';
  if (text.includes('spreadsheetml')) return 'sheet';
  if (text.includes('presentationml')) return 'slide';
  return null;
}
