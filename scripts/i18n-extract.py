#!/usr/bin/env python3
# ------------------------------------------------------------
# i18n-extract.py —— 列出界面上会出现的中文文字，检查英文词典（js/i18n/en-*.js）有没有漏翻
#   python3 scripts/i18n-extract.py            列出所有还没有英文的中文文字（按文件分组）
#   python3 scripts/i18n-extract.py --all      列出全部中文文字（包括已经翻译的）
#   python3 scripts/i18n-extract.py --json F   把结果写成 JSON 文件 F（{分组: [文字, …]}）
# 提取范围：index.html 的文字和 title / aria-label / placeholder / alt，js/ 里的字符串（模板里的 ${…} 换成 {0} {1} …，
# 按 HTML 标签拆开），config/platforms.json 里显示在界面上的字段。注释、console 输出不算。
# 拼接出来的句子（'a' + x + 'b'）提取不准，以界面上实际看到的为准：英文模式下漏翻的文字会记在 window.__i18nMisses 里。
# ------------------------------------------------------------
import json, re, sys, glob, os
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAN = re.compile(r'[㐀-鿿]')
ATTRS = {'title', 'aria-label', 'placeholder', 'alt'}
# 不会出现在界面上的 JS 文件（独立的测试页）
SKIP_JS = {'js/calibrate.js', 'js/webcodecs-slim.js'}
# 平台配置里显示在界面上的字段
CONFIG_KEYS = {'name', 'item', 'requirement', 'passMsg', 'failMsg', 'suggest', 'source', 'desc', 'label'}


def norm(s):
    return re.sub(r'\s+', ' ', s).strip()


def segments(text):
    """一段可能带 HTML 的文字：按标签拆开，返回有中文的片段；标签里的 title 等属性也算"""
    out = []
    for m in re.finditer(r'<[^>]*>', text):
        for a in re.finditer(r'(?:title|aria-label|placeholder|alt)="([^"]*)"', m.group(0)):
            out.append(a.group(1))
    for part in re.split(r'<[^>]*>', text):
        out.append(part)
    res = []
    for p in out:
        p = norm(p.replace('&nbsp;', ' '))
        if not HAN.search(p):
            continue
        # 每个片段里的占位符重新从 0 编号
        n = iter(range(100))
        p = re.sub(r'\{\d+\}', lambda _: '{%d}' % next(n), p)
        res.append(p)
    return res


def js_strings(src):
    """粗略的 JS 词法：跳过注释和正则，取出字符串和模板字符串（${…} 换成 {n}）"""
    i, n, out = 0, len(src), []
    prev = ''  # 上一个非空白字符，用来判断 / 是除号还是正则
    while i < n:
        c = src[i]
        if src.startswith('//', i):
            i = src.find('\n', i)
            i = n if i < 0 else i
            continue
        if src.startswith('/*', i):
            i = src.find('*/', i + 2) + 2
            continue
        if c == '/' and prev and prev in '(,=:[!&|?{};+-*%<>~^':
            j = i + 1
            cls = False
            while j < n and (src[j] != '/' or cls):
                if src[j] == '\\':
                    j += 1
                elif src[j] == '[':
                    cls = True
                elif src[j] == ']':
                    cls = False
                j += 1
            i = j + 1
            prev = '/'
            continue
        if c in '\'"':
            j, buf = i + 1, []
            while j < n and src[j] != c:
                if src[j] == '\\':
                    buf.append({'n': '\n', 't': '\t'}.get(src[j + 1], src[j + 1]))
                    j += 2
                    continue
                buf.append(src[j])
                j += 1
            out.append(''.join(buf))
            i = j + 1
            prev = c
            continue
        if c == '`':
            text, j = template(src, i + 1)
            out.append(text)
            i = j
            prev = '`'
            continue
        if not c.isspace():
            prev = c
        i += 1
    return out


def template(src, i):
    """从模板字符串内容的开头 i 读到结尾的反引号，返回（文字, 结束位置）；${…} 里的字符串单独提取"""
    buf, k = [], 0
    n = len(src)
    while i < n and src[i] != '`':
        if src[i] == '\\':
            buf.append({'n': '\n', 't': '\t'}.get(src[i + 1], src[i + 1]))
            i += 2
            continue
        if src.startswith('${', i):
            depth, j, prev = 1, i + 2, '{'
            while j < n and depth:
                if src[j] == '/' and prev in '(,=:[!&|?{':  # 正则字面量：整段跳过，里面的引号不是字符串
                    j += 1
                    cls = False
                    while j < n and (src[j] != '/' or cls):
                        if src[j] == '\\':
                            j += 1
                        elif src[j] == '[':
                            cls = True
                        elif src[j] == ']':
                            cls = False
                        j += 1
                    j += 1
                    prev = '/'
                    continue
                if not src[j].isspace():
                    prev = src[j]
                if src[j] == '`':
                    inner, j = template(src, j + 1)
                    NESTED.append(inner)
                    continue
                if src[j] in '\'"':
                    q = src[j]
                    j += 1
                    s0 = j
                    while j < n and src[j] != q:
                        j += 2 if src[j] == '\\' else 1
                    NESTED.append(src[s0:j])
                    j += 1
                    continue
                if src[j] == '{':
                    depth += 1
                elif src[j] == '}':
                    depth -= 1
                j += 1
            buf.append('{%d}' % k)
            k += 1
            i = j
            continue
        buf.append(src[i])
        i += 1
    return ''.join(buf), i + 1


NESTED = []


class Html(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip += 1
        for k, v in attrs:
            if k in ATTRS and v and HAN.search(v):
                self.out.append(norm(v))

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip and HAN.search(data):
            self.out.append(norm(data))


def extract():
    groups = {}
    h = Html()
    h.feed(open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read())
    groups['index.html'] = h.out
    for f in sorted(glob.glob(os.path.join(ROOT, 'js/**/*.js'), recursive=True)):
        rel = os.path.relpath(f, ROOT)
        if rel in SKIP_JS or rel.startswith('js/i18n/'):
            continue
        src = open(f, encoding='utf-8').read()
        # console 输出不显示在界面上
        src = re.sub(r'console\.(log|warn|error|info|debug)\((?:[^()]|\([^()]*\))*\)', '', src)
        NESTED.clear()
        strs = js_strings(src) + NESTED
        segs = [s for t in strs for s in segments(t)]
        if segs:
            groups[rel] = segs
    cfg = json.load(open(os.path.join(ROOT, 'config/platforms.json'), encoding='utf-8'))
    out = []

    def walk(o, key=None):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, k)
        elif isinstance(o, list):
            for v in o:
                walk(v, key)
        elif isinstance(o, str) and key in CONFIG_KEYS and HAN.search(o):
            out.append(norm(o))
    walk(cfg)
    groups['config/platforms.json'] = out
    # 去重：同一句只在第一次出现的分组里列出
    seen, res = set(), {}
    for g, items in groups.items():
        keep = []
        for s in items:
            if s not in seen:
                seen.add(s)
                keep.append(s)
        if keep:
            res[g] = keep
    return res


def known():
    """英文词典里已有的中文（键）"""
    keys = set()
    for f in glob.glob(os.path.join(ROOT, 'js/i18n/en-*.js')):
        src = open(f, encoding='utf-8').read()
        for s in js_strings(src):
            keys.add(norm(s))
    return keys


if __name__ == '__main__':
    res = extract()
    if '--all' not in sys.argv:
        k = known()
        res = {g: [s for s in v if s not in k] for g, v in res.items()}
        res = {g: v for g, v in res.items() if v}
    if '--json' in sys.argv:
        json.dump(res, open(sys.argv[sys.argv.index('--json') + 1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    else:
        for g, v in res.items():
            print(f'== {g} ({len(v)})')
            for s in v:
                print('  ' + s)
    print(f'共 {sum(len(v) for v in res.values())} 条', file=sys.stderr)
