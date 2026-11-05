#!/usr/bin/env python3
# ------------------------------------------------------------
# anonymize.py —— 生成匿名评审版：竞赛评审材料不能出现能识别参赛者的信息（姓名、学校、昵称、联系方式等）
#   python3 scripts/anonymize.py <源文件夹> <输出文件夹>
# 做的事：
#   · 整个文件夹拷一份（vendor/ 里的第三方库原样保留）
#   · 文字文件里的产品名 “Eup Preflight” 改成 “Preflight”（Eup 是作者昵称）
#   · index.html 页脚去掉 “made by Eup” 和作者联系方式（邮箱、电话、GitHub）
#   · 最后再搜一遍昵称、邮箱、电话、GitHub 账号，还有残留就报错退出
# 正式版网站不受影响，只在打包时（scripts/package.sh）额外生成一份。
# ------------------------------------------------------------
import os, re, shutil, sys

src, dst = sys.argv[1], sys.argv[2]
TEXT = {'.html', '.js', '.css', '.json', '.md', '.py', '.command', '.bat', '.txt'}
# 页脚：署名和联系方式（index.html 里的写法，见 <footer class="sign">）
FOOTER = [
    (r'<span class="sign-dot">·</span><span>made by Eup</span>', ''),
    (r'\s*<!-- 作者联系方式[^>]*-->\s*<ul class="sign-contact">.*?</ul>', ''),
]
# 不允许残留的身份信息
LEAKS = re.compile(r'\bEup\b|euphon|Euphon0914|189 ?7242 ?3878|8618972423878', re.I)

shutil.rmtree(dst, ignore_errors=True)
shutil.copytree(src, dst)

leaks = []
for root, dirs, files in os.walk(dst):
    if os.path.relpath(root, dst).split(os.sep)[0] == 'vendor':
        continue
    for f in files:
        p = os.path.join(root, f)
        if os.path.splitext(f)[1] not in TEXT:
            continue
        s = open(p, encoding='utf-8').read()
        s = s.replace('Eup Preflight', 'Preflight')
        if os.path.relpath(p, dst) == 'index.html':
            for pat, rep in FOOTER:
                s, n = re.subn(pat, rep, s, flags=re.S)
                if n != 1:
                    sys.exit(f'index.html 页脚没找到要去掉的内容（{pat[:30]}…），页脚结构可能改过，请更新 anonymize.py')
        open(p, 'w', encoding='utf-8').write(s)
        for m in LEAKS.finditer(s):
            leaks.append(f'{os.path.relpath(p, dst)}: {s[max(0, m.start() - 20):m.end() + 20]!r}')
    # 文件名里也不能带昵称（比如启动脚本）
    for f in files:
        if 'Eup ' in f:
            os.rename(os.path.join(root, f), os.path.join(root, f.replace('Eup ', '')))

if leaks:
    print('匿名版里还有身份信息：', *leaks, sep='\n  ')
    sys.exit(1)
print(f'匿名评审版：{dst}')
