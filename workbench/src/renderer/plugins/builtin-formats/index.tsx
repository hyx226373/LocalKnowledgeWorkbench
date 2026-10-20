/**
 * 内置插件 builtin.formats。与 builtin.readers 并列：可禁用，不可卸载，随应用更新。
 * 扩展名只负责选适配器。打开后按文件内容解析，舞台按 DocModel.kind 画。
 */
import React, { useEffect, useState } from 'react';
import { MAX_FORMAT_BYTES } from '../../../shared/formats/limits';
import { MSG } from '../../../shared/formats/messages';
import type { FormatViewState } from '../../../shared/formats/state';
import { FORMAT_ADAPTERS, FORMAT_PLUGIN_ID, FORMAT_PLUGIN_VERSION, type DocModel } from '../../../shared/formats/types';
import { HOST_API_VERSION, type AdapterTarget, type PluginApi, type PluginModule, type AdapterProps as ViewProps } from '../../plugin-host/types';
import { startFormatParse } from './parseClient';
import { FormatStage, persistFormatState, restoreFormatState } from './stage';

const READ = { id: 'read', kind: 'fs.read', scope: 'all-registered-roots', reason: '内置版式阅读器读取你打开的文档' } as const;

function fileScore(extensions: readonly string[]) {
  const allowed = new Set(extensions);
  return (target: AdapterTarget) => {
    if (target.sourceKind !== 'file' || target.resource.kind !== 'file') return 0;
    return allowed.has(target.resource.ext.toLowerCase()) ? 100 : 0;
  };
}

function FormatView({ resource, api, state, setState, reportReady }: ViewProps<FormatViewState>) {
  const [phase, setPhase] = useState<{ doc?: DocModel; failure?: { code: string; message: string } } | null>(null);
  const saved = persistFormatState(state ?? {});

  useEffect(() => {
    let alive = true;
    let frame = 0;
    const finish = (next: { doc?: DocModel; failure?: { code: string; message: string } }) => {
      if (!alive) return;
      setPhase(next);
      if (reportReady) frame = requestAnimationFrame(() => reportReady());
    };
    if (resource.size > MAX_FORMAT_BYTES) {
      finish({ failure: { code: 'too-large', message: MSG.tooLarge } });
      return () => {
        alive = false;
        if (frame) cancelAnimationFrame(frame);
      };
    }
    const job = { cancel() {} };
    void (async () => {
      let bytes: Uint8Array;
      try {
        const response = await fetch(api.workspace.fileUrl(resource));
        if (!response.ok) throw new Error('read');
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        finish({ failure: { code: 'read', message: '读取失败。' } });
        return;
      }
      if (!alive) return;
      if (bytes.byteLength > MAX_FORMAT_BYTES) {
        finish({ failure: { code: 'too-large', message: MSG.tooLarge } });
        return;
      }
      const started = startFormatParse({
        ext: resource.ext,
        mime: undefined,
        size: Math.max(resource.size, bytes.byteLength),
        bytes,
        name: resource.name,
      });
      job.cancel = started.cancel;
      const result = await started.promise;
      if (!alive) return;
      if (result.ok) finish({ doc: result.doc });
      else if (result.doc) finish({ doc: result.doc, failure: { code: result.code, message: result.message } });
      else finish({ failure: { code: result.code, message: result.message } });
    })();
    return () => {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      job.cancel();
    };
    // 文件身份变了才重读。resource 对象每次扫描都会换，但大小和修改时间没变就不重解析。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, resource.resourceId, resource.size, resource.mtimeMs, resource.name, resource.ext]);

  if (!phase) return <div className="kb-notice" data-testid="format-loading">正在解析…</div>;
  return (
    <FormatStage
      doc={phase.doc}
      failure={phase.failure}
      state={saved}
      onState={(next) => setState(persistFormatState(next))}
      onShowInFolder={() => void api.workspace.showInFolder(resource.resourceId)}
    />
  );
}

const plugin: PluginModule = {
  manifest: {
    id: FORMAT_PLUGIN_ID,
    name: '版式文档',
    version: FORMAT_PLUGIN_VERSION,
    engines: { workbench: `^${HOST_API_VERSION}` },
    description: '打开 docx、xlsx、pptx、epub、odt、rtf、ofd，以及 OOXML 或老 OLE 的 wps、et、dps。可禁用，不可单独卸载。',
    activationEvents: ['onStartup'],
    contributes: {
      adapters: FORMAT_ADAPTERS.map((adapter) => ({
        id: adapter.id,
        title: adapter.title,
        sourceKinds: ['file'],
        displayMode: 'in-app-reader',
        match: { extensions: [...adapter.extensions] },
        permissions: [READ],
        stateSchemaVersion: 1,
      })),
    },
  },
  activate(api: PluginApi) {
    for (const adapter of FORMAT_ADAPTERS) {
      api.adapters.register<FormatViewState>({
        id: adapter.id,
        title: adapter.title,
        sourceKinds: ['file'],
        displayMode: 'in-app-reader',
        stateSchemaVersion: 1,
        reportsReady: true,
        match: fileScore(adapter.extensions),
        component: FormatView,
        serializeState: (value) => persistFormatState(value),
        restoreState: restoreFormatState,
      });
    }
  },
};

export default plugin;
