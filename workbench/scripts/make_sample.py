#!/usr/bin/env python3
"""生成样例根目录：md / txt / png / jpg / pdf / 不支持格式，含多级子目录。用法: python3 scripts/make_sample.py /workspace/kb-sample"""
import os, sys, glob
from PIL import Image, ImageDraw, ImageFont

root = sys.argv[1] if len(sys.argv) > 1 else 'kb-sample'
os.makedirs(f'{root}/笔记/2026', exist_ok=True)
os.makedirs(f'{root}/资料/图片', exist_ok=True)
os.makedirs(f'{root}/资料/论文', exist_ok=True)
os.makedirs(f'{root}/空文件夹', exist_ok=True)

fonts = sorted(glob.glob('/usr/share/fonts/**/NotoSansCJK-Regular.ttc', recursive=True) + glob.glob('/usr/share/fonts/**/NotoSerifCJK-Regular.ttc', recursive=True))
def font(sz):
    try:
        return ImageFont.truetype(fonts[0], sz) if fonts else ImageFont.load_default()
    except Exception:
        return ImageFont.load_default()

def card(path, title, color, size=(800, 500), fmt=None):
    im = Image.new('RGB', size, color)
    d = ImageDraw.Draw(im)
    d.rectangle([20, 20, size[0] - 20, size[1] - 20], outline='white', width=4)
    d.text((50, 60), title, fill='white', font=font(48))
    for i in range(8):
        d.ellipse([60 + i * 85, 250, 120 + i * 85, 310], fill=(255, 255 - i * 25, i * 30))
    im.save(path, fmt) if fmt else im.save(path)

card(f'{root}/资料/图片/架构草图.png', '架构草图 PNG', (30, 90, 160))
card(f'{root}/资料/图片/照片.jpg', '照片 JPG', (140, 60, 40))

with open(f'{root}/笔记/2026/读书笔记.md', 'w', encoding='utf-8') as f:
    f.write("""# 读书笔记：本地知识工作台

> 这是一份**样例 Markdown**，用于验证阅读器。

## 要点

1. 原始文件保持原位，索引与元数据单独保存。
2. 多个根目录，迁移时只需重新映射根路径。
3. 外部 Agent 修改文件后，监听器更新索引。

| 格式 | v1 支持 |
| --- | --- |
| Markdown | ✅ |
| PDF | ✅ |
| DOCX | ❌ |

```ts
const hello = '你好，世界';
```

相对路径图片：

![架构草图](../../资料/图片/架构草图.png)

<script>alert('这段脚本应被过滤')</script>
""")

with open(f'{root}/笔记/待办.txt', 'w', encoding='utf-8') as f:
    f.write('待办清单\n' + '\n'.join(f'{i}. 第 {i} 条待办事项：整理资料、阅读论文、写笔记。' for i in range(1, 41)) + '\n')

with open(f'{root}/笔记/gbk编码.txt', 'wb') as f:
    f.write('这是 GBK 编码的文本文件，中文 Windows 上很常见。\n'.encode('gbk'))

with open(f'{root}/资料/数据.csv', 'w', encoding='utf-8') as f:
    f.write('名称,数量\n苹果,3\n香蕉,5\n')

with open(f'{root}/资料/报告.docx', 'wb') as f:
    f.write(b'PK\x03\x04 not really a docx')

# 光栅 PDF（中文，3 页）
pages = []
for i in range(1, 4):
    im = Image.new('RGB', (1240, 1754), 'white')
    d = ImageDraw.Draw(im)
    d.text((100, 120), f'讲义 第 {i} 页', fill='black', font=font(72))
    for j in range(20):
        d.text((100, 300 + j * 60), f'第 {j + 1} 行：本地知识工作台 PDF 阅读器测试内容。', fill=(40, 40, 40), font=font(36))
    pages.append(im)
pages[0].save(f'{root}/资料/论文/讲义.pdf', save_all=True, append_images=pages[1:], resolution=150)

# 矢量文本 PDF（手写，ASCII，可供后续正文抽取测试）
def text_pdf(path, lines_per_page):
    objs = []
    def add(b):
        objs.append(b); return len(objs)
    font_id = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    page_ids = []
    pages_id_placeholder = len(objs) + 1 + 2 * len(lines_per_page)
    for lines in lines_per_page:
        content = 'BT /F1 18 Tf 72 760 Td 24 TL ' + ' '.join(f'({l}) Tj T*' for l in lines) + ' ET'
        cid = add(f'<< /Length {len(content)} >>\nstream\n{content}\nendstream'.encode())
        pid = add(f'<< /Type /Page /Parent {pages_id_placeholder} 0 R /MediaBox [0 0 612 792] /Contents {cid} 0 R /Resources << /Font << /F1 {font_id} 0 R >> >> >>'.encode())
        page_ids.append(pid)
    pages_id = add(f'<< /Type /Pages /Kids [{" ".join(f"{p} 0 R" for p in page_ids)}] /Count {len(page_ids)} >>'.encode())
    assert pages_id == pages_id_placeholder
    cat = add(f'<< /Type /Catalog /Pages {pages_id} 0 R >>'.encode())
    out = bytearray(b'%PDF-1.4\n')
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out)); out += f'{i} 0 obj\n'.encode() + o + b'\nendobj\n'
    x = len(out)
    out += f'xref\n0 {len(objs)+1}\n0000000000 65535 f \n'.encode() + b''.join(f'{o:010d} 00000 n \n'.encode() for o in offs)
    out += f'trailer\n<< /Size {len(objs)+1} /Root {cat} 0 R >>\nstartxref\n{x}\n%%EOF\n'.encode()
    open(path, 'wb').write(out)

text_pdf(f'{root}/资料/论文/paper.pdf', [
    ['Local Knowledge Workbench', '', 'Page 1: vector text PDF for testing.', 'Keyword: reconcile scan'],
    ['Page 2: resource identity', 'Keyword: stable resource id'],
])
print('样例根目录已生成:', os.path.abspath(root))
