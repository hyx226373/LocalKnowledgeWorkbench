// 由 src/shared/theme-contract.json 生成 theme-kit 中的参考文档与起步模板：
//   theme-kit/TOKENS.md、theme-kit/COMPONENTS.md、theme-kit/theme.schema.json、theme-kit/template/*
// 运行：npm run theme:kit（修改主题接口后重新生成；模板只在不存在时创建，不覆盖已有修改）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, 'theme-kit');
const c = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/shared/theme-contract.json'), 'utf8'));
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const hostApi = (fs.readFileSync(path.join(ROOT, 'src/shared/hostApi.ts'), 'utf8').match(/HOST_API_VERSION = '([^']+)'/) ?? [])[1];
fs.mkdirSync(KIT, { recursive: true });

const esc = (s) => String(s).replace(/\|/g, '\\|');
const chrome = c.tokens.filter((t) => t.axis === 'chrome');
const reading = c.tokens.filter((t) => t.axis === 'reading');

// ---- TOKENS.md
{
  const L = [
    '# 主题令牌（自动生成，勿手改）',
    '',
    `主题接口版本 **${c.version}**；宿主 API **${hostApi}**。共 **${c.tokens.length}** 个令牌：外框 ${chrome.length} 个、阅读区 ${reading.length} 个。`,
    '',
    '- 在 `theme.json` 里写令牌名（不带 `--kb-` 前缀）；CSS 中写作 `var(--kb-<名称>)`。',
    '- 外框样式（chromeThemes）只能设置外框令牌；阅读区样式（readingThemes）只能设置 `read-*` 令牌。',
    '- 没有设置的令牌使用下表默认值（浅色 / 深色各一套）。',
    '- 尺寸类令牌（`size-*`、`row-inset`、`dock-gap`、`shell-inset`）只影响外观，不会改变工作区里保存的分栏比例。',
    '- **颜色角色**（v2）：每个颜色令牌都有一个点分语义名（`surface.sunken`、`text.disabled`、`splitter.dragging` …）。设计稿与评审用角色名沟通，theme.json 里写令牌名；两者一一对应（见文末“颜色角色”表）。',
    '- 标 **v2** 的是主题接口 2.0 新增的令牌。改名的令牌见 `MIGRATION-v1-to-v2.md`。',
    '',
  ];
  for (const [title, list] of [['外框令牌（chromeThemes）', chrome], ['阅读区令牌（readingThemes）', reading]]) {
    L.push(`## ${title}`, '');
    let group = null;
    for (const t of list) {
      if (t.group !== group) {
        group = t.group;
        L.push('', `### ${group}`, '', '| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |', '| --- | --- | --- | --- | --- |');
      }
      L.push(`| \`${t.name}\`${t.since === '2.0.0' ? ' **v2**' : ''} | ${t.role ? `\`${t.role}\`` : '—'} | ${esc(t.description)} | \`${esc(t.default.light)}\` | \`${esc(t.default.dark)}\` |`);
    }
    L.push('');
  }
  L.push('## 颜色角色（角色 → 令牌）', '', '| 角色 | 令牌 | 轴 |', '| --- | --- | --- |');
  for (const t of [...c.tokens].filter((t) => t.role).sort((a, b) => a.role.localeCompare(b.role))) L.push(`| \`${t.role}\` | \`${t.name}\` | ${t.axis === 'chrome' ? '外框' : '阅读区'} |`);
  L.push('');
  fs.writeFileSync(path.join(KIT, 'TOKENS.md'), L.join('\n'));
}

// ---- COMPONENTS.md
{
  const L = [
    '# 组件、状态与可用选择器（自动生成，勿手改）',
    '',
    `主题接口 **${c.version}**。这是**唯一权威的组件清单**（${c.components.length} 个组件）：组件状态表（\`npm run theme:shots\` 生成的 states-light.png / states-dark.png）逐个组件、逐个状态渲染这里列出的全部格子；视觉组按本表交付，不再各自维护清单。`,
    '',
    '统一状态集合：',
    '',
    ...c.states.map((s) => `- \`${s}\`：${c.stateDescriptions[s]}`),
    '',
    '“—”表示该组件没有这个状态。标 **v2** 的组件是主题接口 2.0 新增的。',
    '',
    '主题 CSS 的每条规则都必须以下表中的**钩子类**开头（可以接后代、伪类、属性选择器），宿主会自动加上作用域前缀。',
    '',
    '| 组件 | 轴 | 钩子类 | ' + c.states.join(' | ') + ' |',
    '| --- | --- | --- | ' + c.states.map(() => '---').join(' | ') + ' |',
  ];
  for (const k of c.components) {
    L.push(`| ${esc(k.name)}${k.since === '2.0.0' ? ' **v2**' : ''}${k.note ? `<br><small>${esc(k.note)}</small>` : ''} | ${k.axis === 'chrome' ? '外框' : '阅读区'} | \`${esc(k.hook)}\` | ` + c.states.map((s) => (k.states[s] ? `\`${esc(k.states[s])}\`` : '—')).join(' | ') + ' |');
  }
  L.push(
    '',
    '## CSS 规则',
    '',
    '- 只允许：令牌赋值（在 theme.json 中）+ 以钩子类开头的受限 CSS。',
    `- 禁止的属性（会改变布局）：${c.css.disallowedProperties.map((p) => `\`${p}\``).join('、')}。`,
    `- 允许的 @规则：${c.css.allowedAtRules.map((p) => `\`${p}\``).join('、')}；其余 @规则（含 @import、@font-face）一律拒绝。`,
    `- 禁止的值：${c.css.forbiddenValues.map((p) => `\`${p}\``).join('、')}（不能加载外部资源）。`,
    '- 不能定义或改写 `--kb-*` 变量（令牌只能在 theme.json 中设置）；不能选择 `html`、`body`、`*`、`#id`。',
    '- 外框 CSS 不能选择阅读区钩子（`.kb-reading`、`.kb-md`、`.kb-pdf-page` …），反之亦然。',
    '- 改变分栏排列的需求一律写成**布局预设 JSON**（见 template/layouts/example.json），不属于主题。',
    '',
  );
  fs.writeFileSync(path.join(KIT, 'COMPONENTS.md'), L.join('\n'));
}

// ---- theme.schema.json
{
  const chromeProps = Object.fromEntries(chrome.map((t) => [t.name, { type: 'string', description: t.description }]));
  const readingProps = Object.fromEntries(reading.map((t) => [t.name, { type: 'string', description: t.description }]));
  const variant = (props) => ({ type: 'object', additionalProperties: false, properties: { tokens: { type: 'object', additionalProperties: false, properties: props }, css: { type: 'string', description: '包内相对路径，如 chrome.css' } } });
  const theme = (props) => ({ type: 'object', required: ['id', 'label', 'light', 'dark'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]{1,63}$' }, label: { type: 'string' }, description: { type: 'string' }, light: variant(props), dark: variant(props) } });
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'kb-workbench/theme.schema.json',
    title: '本地知识工作台主题包 theme.json',
    type: 'object',
    required: ['id', 'name', 'version', 'engines', 'contributes'],
    properties: {
      $schema: { type: 'string' },
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]{1,63}$', description: '全局唯一；不要与内置 kb.theme.* 重复' },
      name: { type: 'string' },
      version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+' },
      description: { type: 'string' },
      engines: { type: 'object', required: ['workbench', 'themeContract'], properties: { workbench: { type: 'string', description: `宿主 API 范围，当前 ^${hostApi}` }, themeContract: { type: 'string', description: `主题接口范围，当前 ^${c.version}` } } },
      contributes: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chromeThemes: { type: 'array', items: theme(chromeProps) },
          readingThemes: { type: 'array', items: theme(readingProps) },
          layoutPresets: { type: 'array', items: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } } },
        },
      },
    },
  };
  fs.writeFileSync(path.join(KIT, 'theme.schema.json'), JSON.stringify(schema, null, 2) + '\n');
}

// ---- src/renderer/styles.css 顶部 :root 兜底值（= 深色默认值）
{
  const p = path.join(ROOT, 'src/renderer/styles.css');
  const css = fs.readFileSync(p, 'utf8');
  const line = ':root { ' + c.tokens.map((t) => `--kb-${t.name}: ${t.default.dark};`).join(' ') + ' }';
  fs.writeFileSync(p, css.replace(/^:root \{[^}]*\}/m, line));
}

// ---- template/（只在不存在时创建）
{
  const T = path.join(KIT, 'template');
  const put = (rel, text) => {
    const p = path.join(T, rel);
    if (fs.existsSync(p)) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };
  const toks = (list, scheme) => Object.fromEntries(list.map((t) => [t.name, t.default[scheme]]));
  put(
    'theme.json',
    JSON.stringify(
      {
        $schema: '../theme.schema.json',
        id: 'contractor.example',
        name: '示例主题（请改名）',
        version: '0.1.0',
        description: '从 theme-kit/template 复制。令牌值为当前默认值，按需修改；不需要改的可以删掉（使用默认值）。',
        engines: { workbench: `^${hostApi}`, themeContract: `^${c.version}` },
        contributes: {
          chromeThemes: [{ id: 'example', label: '示例外框', light: { css: 'chrome.css', tokens: toks(chrome, 'light') }, dark: { css: 'chrome.css', tokens: toks(chrome, 'dark') } }],
          readingThemes: [{ id: 'example', label: '示例阅读区', light: { css: 'reading.css', tokens: toks(reading, 'light') }, dark: { css: 'reading.css', tokens: toks(reading, 'dark') } }],
          layoutPresets: [{ file: 'layouts/example.json' }],
        },
      },
      null,
      2,
    ) + '\n',
  );
  put(
    'chrome.css',
    `/* 外框样式的受限 CSS（可留空）。规则必须以钩子类开头，见 ../COMPONENTS.md。
   宿主会自动加作用域前缀，浅色/深色可以共用一个文件，也可以分开。
   禁止：布局属性（width/height/margin/display/position/transform…）、url()、@import、改写 --kb-* 变量。 */

.kb-section-title { letter-spacing: .1em; }
.kb-tree-row[aria-selected="true"] { font-weight: 600; }
.kb-dock .dv-tab { border-radius: var(--kb-radius-sm) var(--kb-radius-sm) 0 0; }
`,
  );
  put(
    'reading.css',
    `/* 阅读区样式的受限 CSS（可留空）。只能选择阅读区钩子：.kb-reading / .kb-md / .kb-pdf-page / .kb-table … */

.kb-md h1 { letter-spacing: .02em; }
.kb-md blockquote { font-style: normal; }
`,
  );
  put(
    'layouts/example.json',
    JSON.stringify(
      {
        id: 'example.reading-desk',
        label: '阅读桌（左宽右窄，右侧上下）',
        description: '布局预设只决定分栏排列：现有分组按顺序放入 slot 1、2、3…；多出的分组并入最后一个 slot；空 slot 自动去掉。不会改变打开的文件与阅读进度。',
        sidebarWidth: 260,
        grid: { split: 'row', children: [{ slot: 1, size: 3 }, { split: 'column', size: 2, children: [{ slot: 2, size: 1 }, { slot: 3, size: 1 }] }] },
      },
      null,
      2,
    ) + '\n',
  );
}
console.log(`theme-kit 已生成：${c.tokens.length} 个令牌（外框 ${chrome.length} / 阅读区 ${reading.length}），${c.components.length} 个组件，${c.states.length} 种状态`);
