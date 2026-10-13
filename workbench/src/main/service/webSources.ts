/**
 * r12-P6：网络来源的落盘形态。
 * 不新建第二套身份。视图 `web_sources(id, url, title, created_at)` 对准冻结草案；
 * 行在 A 的 `web_resources` 里。不写 resources_fts，不缓存正文。
 * 不进 MIGRATIONS，不改 user_version。本块版本号 1206，不要复用 P1 的 1201。
 */
import type { DB } from './db';
import { migrateWebResources } from '../webResources';

export const WEB_SOURCES_VERSION = 1206;

export function migrateWebSources(db: DB): void {
  migrateWebResources(db);
  db.exec(`CREATE VIEW IF NOT EXISTS web_sources AS
    SELECT resource_id AS id, url, title, added_at AS created_at FROM web_resources`);
}
