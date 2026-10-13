/**
 * 网站授权的内存表。判断路径只查表；读盘和写盘都是异步的，且不在请求回调里。
 * 配置在应用数据目录的 web-site-grants.json，不写进资料文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  emptyDocument,
  judgeSubresource,
  parseWebSiteGrantDocument,
  registrableDomain,
  serializeWebSiteGrantDocument,
  type GrantSnapshot,
  type SiteChoice,
  type SiteGrant,
  type SiteSource,
  type SubresourceJudgment,
  type WebSiteGrantDocument,
  type WebSiteGrantRow,
} from '../shared/webSiteGrant';

export class WebSiteGrantStore {
  private globalNeverBlock = false;
  private readonly live = new Map<string, SiteGrant>();
  private readonly persisted = new Map<string, SiteGrant>();
  private tail: Promise<void> = Promise.resolve();
  /** 只在 load() 里增加。判断路径不得增加它。 */
  ioReads = 0;

  constructor(private readonly file: string) {}

  filePath(): string {
    return this.file;
  }

  /** 启动时调用一次。请求路径不再读盘。 */
  async load(): Promise<void> {
    this.ioReads++;
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      return;
    }
    const doc = parseWebSiteGrantDocument(text);
    if (!doc) return;
    this.globalNeverBlock = doc.globalNeverBlock;
    this.persisted.clear();
    for (const [site, row] of [...this.live]) {
      if (row.persistence === 'always') this.live.delete(site);
    }
    for (const [site, row] of Object.entries(doc.sites)) {
      const grant: SiteGrant = { decision: row.decision, persistence: 'always', source: row.source, at: row.at };
      this.persisted.set(site, grant);
      this.live.set(site, grant);
    }
  }

  snapshot(): GrantSnapshot {
    return { globalNeverBlock: this.globalNeverBlock, sites: this.live };
  }

  /** 请求路径：微任务后查内存表，不读盘。 */
  async judge(url: string, domains: readonly string[], opts?: { allowHttp?: boolean }): Promise<SubresourceJudgment> {
    await Promise.resolve();
    return judgeSubresource(url, domains, opts, this.snapshot());
  }

  /** will-navigate 一类必须同步 preventDefault 的钩子。同样只查内存表。 */
  judgeNow(url: string, domains: readonly string[], opts?: { allowHttp?: boolean }): SubresourceJudgment {
    return judgeSubresource(url, domains, opts, this.snapshot());
  }

  document(): WebSiteGrantDocument {
    const sites: WebSiteGrantDocument['sites'] = {};
    for (const [site, row] of this.persisted) sites[site] = { decision: row.decision, source: row.source, at: row.at };
    return { version: 1, globalNeverBlock: this.globalNeverBlock, sites };
  }

  list(): { version: 1; file: string; globalNeverBlock: boolean; sites: WebSiteGrantRow[] } {
    const sites = [...this.live.entries()]
      .map(([site, row]) => ({ site, ...row }))
      .sort((a, b) => a.site.localeCompare(b.site));
    return { version: 1, file: this.file, globalNeverBlock: this.globalNeverBlock, sites };
  }

  async allow(site: string, choice: SiteChoice, source: SiteSource): Promise<void> {
    const key = registrableDomain(site);
    if (!key) throw new Error('网站名无效');
    const grant: SiteGrant = {
      decision: choice === 'deny' ? 'deny' : 'allow',
      persistence: choice === 'session' ? 'session' : 'always',
      source,
      at: new Date().toISOString(),
    };
    this.live.set(key, grant);
    if (grant.persistence === 'session') return;
    this.persisted.set(key, grant);
    await this.scheduleWrite();
  }

  async allowAll(sites: readonly string[]): Promise<void> {
    const at = new Date().toISOString();
    for (const site of sites) {
      const key = registrableDomain(site);
      if (!key) continue;
      const grant: SiteGrant = { decision: 'allow', persistence: 'always', source: 'allow-all', at };
      this.live.set(key, grant);
      this.persisted.set(key, grant);
    }
    await this.scheduleWrite();
  }

  async neverBlockSite(site: string): Promise<void> {
    const key = registrableDomain(site);
    if (!key) throw new Error('网站名无效');
    const grant: SiteGrant = { decision: 'never-block', persistence: 'always', source: 'manual', at: new Date().toISOString() };
    this.live.set(key, grant);
    this.persisted.set(key, grant);
    await this.scheduleWrite();
  }

  async setGlobalNeverBlock(enabled: boolean): Promise<void> {
    this.globalNeverBlock = enabled;
    await this.scheduleWrite();
  }

  async revoke(site: string): Promise<void> {
    const key = registrableDomain(site);
    if (!key) throw new Error('网站名无效');
    this.live.delete(key);
    this.persisted.delete(key);
    await this.scheduleWrite();
  }

  private scheduleWrite(): Promise<void> {
    const run = this.tail.then(() => this.writeCurrent());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async writeCurrent(): Promise<void> {
    const body = serializeWebSiteGrantDocument({ ...emptyDocument(), ...this.document() });
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, body, 'utf8');
  }
}
