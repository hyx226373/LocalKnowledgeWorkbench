/** 上次进程被杀掉后，第一次打开可能撞上还没松开的 WAL 映射。这种错误才重开。 */
export function reopenAfterIoError(message: string, attempt: number): boolean {
  return attempt < 7 && /IOERR|disk I\/O|locked|busy|TRUNCATE/i.test(message);
}
