/**
 * afterSign：把 Windows exe 的 FileDescription（资源管理器「文件说明」/任务管理器显示名）
 * 设为「本地知识工作台」，同时保留 ProductName / InternalName 为英文 LocalKnowledgeWorkbench。
 *
 * 时机：electron-builder 在 signAndEditResources（默认把 FileDescription=productName）之后调用本钩子；
 * KB_WIN_UNSIGNED=1（signExecutable=false）时仍会 edit resources 且 signApp 返回 true，故 afterSign 会跑到。
 * 禁止改 productName / artifact 文件名。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE_DESCRIPTION = '本地知识工作台';

export default async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return;

  const productFilename = context.packager.appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);

  const { NtExecutable, NtExecutableResource, Resource } = await import('resedit');
  const buffer = await readFile(exePath);
  const executable = NtExecutable.from(buffer);
  const res = NtExecutableResource.from(executable);
  const viList = Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length === 0) {
    console.warn(`[afterSign-file-description] no VersionInfo in ${exePath}; skip`);
    return;
  }
  const vi = viList[0];
  const languages = vi.getAllLanguagesForStringValues();
  const lang = languages.length > 0 ? languages[0] : { lang: 0x0409, codepage: 1200 };

  // 只覆盖 FileDescription；ProductName 等保持 electron-builder 已写入的英文 productName
  vi.setStringValues(lang, { FileDescription: FILE_DESCRIPTION });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(executable);
  await writeFile(exePath, Buffer.from(executable.generate()));
  console.log(`[afterSign-file-description] FileDescription → 「${FILE_DESCRIPTION}」 @ ${exePath}`);
}
