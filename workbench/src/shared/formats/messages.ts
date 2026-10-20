/** 给阅读器看的中文说明。密码、正文、外部地址都不放进这些句子。 */
export const MSG = {
  tooLarge: '文件超过 80 MB，无法在应用内解析。',
  zipLimit: '压缩包超过安全限制，已停止解析。',
  encrypted: '文件已加密，应用内无法打开。',
  timeout: '解析超过 10 秒，已停止。',
  corrupt: '文件已损坏，无法阅读。',
  unsupported: '无法识别此文件的具体格式。',
  layoutLost: '版式已丢失，以下为抽出的纯文本。',
  magicMismatch: '扩展名与文件内容不一致，已按实际内容打开。',
  externalRel: '已忽略指向外部的关系。',
  xmlUnsafe: '文档包含不安全的 XML 声明，已拒绝解析。',
  truncated: '内容过长，只显示前面一部分。',
  sealIgnored: '已忽略电子签章。',
} as const;
