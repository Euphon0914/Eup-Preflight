# 前端视觉与动效升级 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Eup Preflight 加上首屏、霓虹柠檬品牌色、细化的液态玻璃，以及导入分析 / 结论揭晓 / 一键修复三个时刻的动效，用于参赛现场演示。

**Architecture:** 纯前端、无构建。Motion 14.2.0 的 UMD 文件放进 `vendor/motion/`，由新的 `js/core/motion.js` 统一封装（参数、只播一次、减少动态效果、库缺失兜底）；首屏由 `js/core/hero.js` + `js/lib/hero-canvas.js` 负责；其余动效在现有模块的渲染函数里调用 `motion.js`。所有元素的 CSS 默认就是最终状态，初始状态只由动画关键帧给出，所以动画不播时页面照样正确。

**Tech Stack:** 原生 ES Modules、CSS 变量、Motion 14.2.0（UMD，`window.Motion`）、Canvas 2D。

**Spec:** `docs/superpowers/specs/2026-10-30-frontend-redesign-design.md`

## Global Constraints

- 不引入构建步骤；新第三方文件只放 `vendor/`，由 `scripts/download-vendor.sh` 按固定版本下载（`vendor/` 不入库）。
- Motion 固定 `14.2.0`，文件 `dist/motion.js`，期望字节数 `153875`，MIT 许可。
- 品牌色：`--brand: #C8F03C`、`--on-brand: #1A2600`、`--brand-ink` 浅色 `#5A7A00` / 深色 `#C8F03C`、`--brand-glow` 浅色 `rgba(200, 240, 60, .35)` / 深色 `rgba(200, 240, 60, .45)`。
- 品牌色只用于：主按钮、选中步骤图标底、进度条与扫描线、焦点框、logo 色块、首屏标题高亮。状态标记（通过 / 警告 / 不通过）不用品牌色。
- “通过”色：浅色约 `#1F7A5C`、深色约 `#4FD1A5`，与各自背景对比度 ≥ 4.5:1。
- 动效参数：时长 快 `0.18s` / 标准 `0.32s` / 强调 `0.6s`；缓动 `cubic-bezier(.2, .8, .2, 1)`；弹簧 `{ stiffness: 380, damping: 30 }`（snappy）、`{ stiffness: 220, damping: 26 }`（soft）。
- 动画只改 `transform` / `opacity`（描边动画改 `stroke-dashoffset`），不对 `backdrop-filter`、`filter`、尺寸做动画。
- “减少动态效果”下：只保留 ≤ 0.15 秒的淡入淡出；扫描线、Canvas、数字滚动、演示循环全部关闭，直接显示最终状态。
- 检查逻辑、处理逻辑、`config/platforms.json` 不改。
- 代码风格沿用现有：中文注释、`$()` 取元素、模块顶部 `// ====` 说明块。
- 所有用户可见文字为简体中文。

## Review Focus

1. **重复渲染导致动画重播**：声音分析进度每次更新都会 `innerHTML` 重渲染结论区；期望揭晓动画只在 key（文件 + 平台 + 结论 + 是否仍在分析）变化时播一次。——Task 6 验证步骤覆盖。
2. **Motion 文件缺失或加载失败**（只拿到 git 仓库、没跑下载脚本）：期望页面功能完全正常、元素直接显示最终状态、控制台一条警告。——Task 1 验证步骤覆盖。
3. **分析途中点 logo 回首屏 / 首屏上再拖入新视频**：期望 `state.busy` 时不能载入新视频（沿用 `loadVideo` 现有判断），回首屏不打断正在跑的分析，“继续检查”回到工作台后进度仍在。——Task 3 验证步骤覆盖。
4. **一键修复失败或取消**：期望阶段清单停在出错阶段、不出现“完成翻转”和下载脉冲，弹窗回到选择修复项。——Task 7 验证步骤覆盖。
5. **自动载入上次视频**：打开页面时首屏短暂出现后被自动载入替换，期望不闪烁——有可自动载入的视频时首屏不显示，直接进入工作台（载入失败再显示首屏）。——Task 3 验证步骤覆盖。

## 验证方式说明

项目没有自动化测试框架，本计划用浏览器预览做验证：用 `.claude/launch.json` 里的 `eup-preflight` 启动（端口 3123），在页面控制台执行给定表达式，对比期望结果；视觉类检查截图。每个任务的“验证”步骤就是它的测试：先在改动前执行一遍确认失败（或元素不存在），实现后再执行确认通过。

需要“没有视频”的状态时，先执行：

```js
localStorage.setItem('autoLoadLastVideo', '0'); location.reload();
```

需要“有视频”的状态时，点首屏 / 拖放区里的“没有素材？生成一段测试视频”（`#testBtn`），等进度消失。

---

### Task 0: 记录性能基线

**Files:**
- Create: `docs/superpowers/plans/2026-10-30-perf-baseline.md`

- [ ] **Step 1: 准备测试视频**：准备一段约 2 分钟、带声音、1080P 以上的真实视频（作者本机素材），记下文件名和大小。
- [ ] **Step 2: 在改动前的代码上测量**：打开「高级」，载入该视频，等分析完成；再点「一键修复」勾选默认项处理一次。从「每一步耗时」表格抄下“读取参数”“响度分析”“转码 / 视频转码”“合并音视频”“截取对比画面”的耗时。重复一次取平均。
- [ ] **Step 3: 写入基线文件**：表格列为 步骤 / 第 1 次 / 第 2 次 / 平均，并记录浏览器版本和机器型号。
- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-10-30-perf-baseline.md
git commit -m "记录动效改造前的性能基线"
```

---

### Task 1: 引入 Motion 与动效封装 `motion.js`

**Files:**
- Modify: `scripts/download-vendor.sh`（版本区加 `MOTION_VER="14.2.0"`，mediabunny 那段后面加下载行）
- Modify: `THIRD_PARTY_NOTICES.md`、`licenses.html`（加 Motion 条目和 MIT 许可原文，格式照 `@ffmpeg/ffmpeg` 那节）
- Create: `js/core/motion.js`
- Modify: `index.html`（`<script type="module" src="js/main.js">` 前加 `<script src="vendor/motion/motion.js"></script>`）

**Interfaces:**
- Produces（`js/core/motion.js` 导出，后续任务都用这些名字）：
  - `DUR = { fast: 0.18, base: 0.32, emph: 0.6 }`
  - `EASE = [0.2, 0.8, 0.2, 1]`
  - `SPRING = { snappy: { type: 'spring', stiffness: 380, damping: 30 }, soft: { type: 'spring', stiffness: 220, damping: 26 } }`
  - `reducedMotion(): boolean` —— `matchMedia('(prefers-reduced-motion: reduce)').matches`
  - `hasMotion(): boolean` —— `typeof window.Motion?.animate === 'function'`
  - `animate(el: Element, keyframes: object, options?: object): Promise<void>` —— 包装 `Motion.animate`。无 Motion：把每个属性的最后一帧写到 `el.style` 后立即 resolve。减少动态效果：只保留 `opacity`，时长截到 0.15 秒，其余属性直接设为最后一帧。
  - `reveal(el: Element, key: string, run: () => void): boolean` —— `el.dataset.revealKey === key` 时不调用 `run`、返回 `false`；否则写入 key、调用 `run`、返回 `true`。
  - `countUp(el: Element, to: number, opts?: { duration?: number }): void` —— 从 `el.dataset.countFrom`（默认 0）滚到 `to`，结束写 `dataset.countFrom = to`；无 Motion 或减少动态效果时直接写最终值。
  - `stagger(els: Element[], opts?: { gap?: number, y?: number }): void` —— 默认 `gap 0.04`、`y 8`，每个元素 `opacity 0→1`、`translateY y→0`，用 `SPRING.soft`。
  - `drawStroke(svg: SVGElement): void` —— 对 svg 内每个 `path` / `polyline` 用 `getTotalLength()` 设 `stroke-dasharray`，`stroke-dashoffset` 从全长动到 0，时长 `DUR.emph`。
  - `flyFrom(from: DOMRect, el: Element, opts?: { spring?: object }): Promise<void>` —— FLIP：用 `from` 与 `el` 当前矩形算位移和缩放，`transform` 从差值动画到 none，默认 `SPRING.soft`。
  - `pulse(el: Element): void` —— 一次品牌色光晕：`box-shadow` 不做动画，改为给 `el` 加 `.pulse` 类（CSS keyframes 在 Task 2 的 `base.css` 里定义），`animationend` 后移除。

- [ ] **Step 1: 写验证（改动前执行应失败）**：在控制台执行

```js
const m = await import('/js/core/motion.js');
const d = document.createElement('div'); document.body.append(d);
const r1 = m.reveal(d, 'a', () => {}), r2 = m.reveal(d, 'a', () => {}), r3 = m.reveal(d, 'b', () => {});
m.countUp(d, 19); await new Promise((r) => setTimeout(r, 900));
[m.hasMotion(), r1, r2, r3, d.textContent, m.DUR.emph, m.SPRING.soft.stiffness]
```

期望（实现后）：`[true, true, false, true, "19", 0.6, 220]`。改动前：import 报 404。

- [ ] **Step 2: 下载脚本加 Motion 并运行**：`get motion "$MOTION_VER" dist/motion.js vendor/motion/motion.js 153875`；运行 `CDN=npmmirror bash scripts/download-vendor.sh`，确认 `vendor/motion/motion.js` 为 153875 字节。
- [ ] **Step 3: 实现 `js/core/motion.js`**（上述全部导出；模块加载时若 `!hasMotion()`，`console.warn('动画库未加载，页面照常可用，只是没有动画')` 一次）。
- [ ] **Step 4: `index.html` 引入 UMD 文件**。
- [ ] **Step 5: 运行 Step 1 的验证**，期望 `[true, true, false, true, "19", 0.6, 220]`。
- [ ] **Step 6: 兜底验证**：临时把 `vendor/motion/motion.js` 改名，刷新页面，执行 Step 1 的表达式，期望 `[false, true, false, true, "19", 0.6, 220]`，控制台有那条警告，生成测试视频后体检照常出结果。改回文件名。
- [ ] **Step 7: 许可说明**：`THIRD_PARTY_NOTICES.md` 和 `licenses.html` 加 Motion（版本、用途“界面动效”、MIT 原文，取自包内 `LICENSE.md`）。
- [ ] **Step 8: 提交**

```bash
git add scripts/download-vendor.sh js/core/motion.js index.html THIRD_PARTY_NOTICES.md licenses.html
git commit -m "引入 Motion 14.2.0 和动效封装 motion.js（减少动态效果、库缺失时直接显示最终状态）"
```

---

### Task 2: 视觉系统——品牌色、状态色、玻璃细化、logo 色块

**Files:**
- Modify: `css/base.css`（`:root` 与深色块；`.btn.primary`；`:focus-visible`；`.logo`、`.sign-mark`、`.brand-tag`；`.glass`；`.badge.pass`；新增 `.pulse` keyframes；动效变量）
- Modify: `css/shell.css`（`.steps button.on .step-ico`、`.bar > div`、`.drop-icon`、`.panel-title h1`）
- Modify: `css/tech.css`（`.verdict-title` 数字字号、`.fb-icon` 用 `--pass`）
- Modify: `index.html`、`calibrate.html`、`licenses.html`、`webcodecs-test.html`（logo 内的 SVG 删除，favicon 换成色块）
- Modify: `js/core/ui.js`（`badge('pass')` 前加对勾图标）
- Create: `js/core/glass-light.js`（鼠标反光）
- Modify: `js/main.js`（调用 `mountGlassLight()`）

**Interfaces:**
- Produces（CSS 变量，后续任务使用）：`--brand`、`--on-brand`、`--brand-ink`、`--brand-glow`、`--dur-fast: .18s`、`--dur-base: .32s`、`--dur-emph: .6s`、`--ease: cubic-bezier(.2, .8, .2, 1)`；类 `.pulse`。
- Produces：`mountGlassLight(): void`（`js/core/glass-light.js`）——在 `(hover: hover) and (pointer: fine)` 下，监听 `.glass.lit` 元素的 `pointermove`，用 `requestAnimationFrame` 节流写 `--mx` / `--my`（相对元素的百分比）。`.right`、`.dlg-box`、首屏拖放区加 `lit` 类。

- [ ] **Step 1: 写验证（改动前执行应失败）**：

```js
const cs = getComputedStyle(document.documentElement), q = (s) => document.querySelector(s);
[cs.getPropertyValue('--brand').trim(), cs.getPropertyValue('--dur-emph').trim(),
 getComputedStyle(q('.logo')).backgroundColor, q('.logo svg'), q('link[rel=icon]').href.includes('C8F03C')]
```

期望（实现后）：`["#C8F03C", ".6s", "rgb(200, 240, 60)", null, true]`。

- [ ] **Step 2: 颜色与动效变量**：按 Global Constraints 写入 `:root` 和深色块；`--pass` 改为 `#1F7A5C`（浅）/ `#4FD1A5`（深），`--pass-bg` 同色 12% / 14% 透明度。
- [ ] **Step 3: 品牌色落位**：`.btn.primary`（背景 `--brand`、文字 `--on-brand`、悬停加 `0 6px 22px var(--brand-glow)` 阴影）、`.steps button.on .step-ico`、`.bar > div`、`:focus-visible`（`outline-color: var(--brand-ink)`）、`.drop-icon`、`.count.dot`。`.brand-tag` 保持黑白。
- [ ] **Step 4: logo 色块**：`.logo`、`.sign-mark` 背景 `--brand`，删除四个页面里 `.logo` / `.sign-mark` 内的 SVG；favicon 统一为 `data:image/svg+xml` 的 24×24、`rx="6.5"`、`fill="#C8F03C"` 色块。
- [ ] **Step 5: 玻璃细化**：`.glass` 增加顶部内高光（`inset 0 1px 0` 白色 60% / 深色 12%）和两层阴影（接触 `0 1px 2px` + 投影 `0 18px 50px`）；`.glass::after` 叠一层 `feTurbulence` 噪点数据 URI（`opacity .035`，深色 `.05`，`pointer-events: none`，`z-index: 0`）；`.glass.lit::after` 再叠一个 `radial-gradient(240px circle at var(--mx, 50%) var(--my, 0%), rgba(255,255,255,.18), transparent 70%)`。实现 `glass-light.js` 并在 `main.js` 挂载。
- [ ] **Step 6: 状态标签对勾**：`ui.js` 的 `badge` 对 `pass` 输出 `✓ 通过`。
- [ ] **Step 7: 文字层级**：`.panel-title h1` 32px、`font-family: "SF Pro Display", var(--font)`；窄屏仍为 23px。
- [ ] **Step 8: `.pulse`**：`@keyframes brand-pulse { 0% { box-shadow: 0 0 0 0 var(--brand-glow); } 100% { box-shadow: 0 0 0 14px transparent; } }`，时长 `var(--dur-emph)` × 2；减少动态效果下不播放。
- [ ] **Step 9: 运行 Step 1 的验证**，期望如上。
- [ ] **Step 10: 视觉检查**：浅色、深色各截图一张工作台（有视频、有问题项），确认：主按钮为柠檬色深字；通过标记带对勾且与柠檬色明显不同；玻璃有顶部高光；鼠标在右侧面板上移动时有反光跟随；校准页、许可页 logo 和 favicon 已换。
- [ ] **Step 11: 提交**

```bash
git add css/ js/core/ui.js js/core/glass-light.js js/main.js index.html calibrate.html licenses.html webcodecs-test.html
git commit -m "视觉系统：霓虹柠檬品牌色、通过色偏蓝并加对勾、玻璃高光与噪点和鼠标反光、logo 改色块占位"
```

---

### Task 3: 首屏（布局、演示循环、回到首屏、继续检查）

**Files:**
- Create: `js/core/hero.js`、`css/hero.css`
- Modify: `index.html`（`<main class="workspace">` 前加 `<section id="hero" class="hero" hidden>`；引入 `css/hero.css`；顶栏 `.brand` 改为 `<button class="brand" id="homeBtn" aria-label="回到首页">`）
- Modify: `js/core/shell.js`（`renderLeft()` 开头调用 `syncHero()`；`#drop` 上的拖放处理同样作用于首屏拖放区）
- Modify: `js/main.js`（`mountShell()` 后调用 `mountHero()`；自动载入判断前不显示首屏）

**Interfaces:**
- Consumes：`animate`、`stagger`、`reducedMotion`、`DUR`、`SPRING`（Task 1）
- Produces（`js/core/hero.js`）：
  - `mountHero(): void` —— 绑定首屏按钮、logo 点击、“继续检查”。
  - `showHero(): void` / `hideHero(): void` —— 切换 `#hero` 与 `.workspace` 的 `hidden`，以及 `body.on-hero` 类（顶栏副标题 `.brand-sub` 在 `body.on-hero` 下隐藏）。
  - `syncHero(): void` —— 由 `renderLeft()` 调用：没有 `state.original?.info` 且 `!state.heroSuppressed` 时 `showHero()`；有视频且 `state.view !== 'hero'` 时 `hideHero()`。
  - `state.view: 'hero' | 'workspace'`（加到 `store.js` 的 `state`，默认 `'workspace'`）——logo 点击设为 `'hero'`，“继续检查”和载入视频设为 `'workspace'`。
  - `state.heroSuppressed: boolean`（默认 `true`）——`main.js` 在自动载入流程结束（成功或失败或不需要）后设为 `false` 并 `notify('update')`。
  - `heroShowCount(): number` —— 本次页面加载以来 `showHero()` 真正把首屏从隐藏变为显示的次数（验证“自动载入不闪”用）。
- 首屏 DOM id：`#hero`、`#heroDrop`、`#heroPick`、`#heroTest`、`#heroContinue`、`#heroPhone`、`.hero-cap`（三张能力卡片）、`#heroCanvas`（Task 4 用）。

- [ ] **Step 1: 写验证（改动前执行应失败）**：在“没有视频”状态下

```js
const h = document.querySelector('#hero');
[!!h && !h.hidden, document.querySelector('.workspace').hidden, document.body.classList.contains('on-hero'),
 document.querySelectorAll('.hero-cap').length, document.querySelector('#heroContinue')?.hidden]
```

期望：`[true, true, true, 3, true]`。

- [ ] **Step 2: 首屏结构与样式**：文案逐字使用——小字“抖音 / TikTok 发片前检查 · 本机处理，不上传”；大标题“发片之前，先 <mark>Preflight</mark> 一遍”（`mark` 用 `--brand` 底、`--on-brand` 字）；拖放区“把视频拖到这里”+ 主按钮“选择视频”+ 链接“没有素材？生成一段测试视频”；能力卡片“技术体检 / 规格不对一键修复”“画面遮挡 / 字幕会不会被按钮挡”“封面适配 / 各比例裁切预览”（图标复用步骤导航里的三个 SVG）。宽屏两栏（左 1.25fr / 右 1fr），≤ 900px 上下堆叠、手机框缩到 160px 宽。“选择视频”触发 `#fileInput`，“生成测试视频”调用 `loadTestVideo()`。
- [ ] **Step 3: 演示循环 `#heroPhone`**：手机框内一张深灰渐变“画面”，四个阶段循环（每轮约 4.8 秒，轮间停 1.2 秒）：扫描线 `translateY` 0→100%（1.6 秒）→ 右侧按钮列和底部文案区两个虚线框依次 `stagger` 浮现 → 底部字幕块闪烁两次（warn 色描边）→ 中央对勾 `drawStroke`。首屏隐藏或 `document.hidden` 时停止循环；减少动态效果时只显示最终帧。
- [ ] **Step 4: 显示规则**：实现 `syncHero` / `state.view` / `state.heroSuppressed`；logo 点击：`state.view = 'hero'`，有视频时 `#heroContinue` 显示“继续检查 <文件名>”。首屏上拖入视频走原有 `loadVideo`，载入时 `state.view = 'workspace'`。
- [ ] **Step 5: 运行 Step 1 的验证**，期望 `[true, true, true, 3, true]`。
- [ ] **Step 6: 验证回到首屏 / 继续检查（Review Focus 3）**：载入测试视频，分析进行中点 logo——首屏出现、`#heroContinue` 可见；此时拖入另一个视频不触发载入（`state.original.file.name` 不变）；点“继续检查”回到工作台，进度条仍在推进，分析正常结束。
- [ ] **Step 7: 验证自动载入不闪（Review Focus 5）**：执行 `localStorage.setItem('autoLoadLastVideo','1')`，确保“最近”里有视频，刷新；等工作台出现后执行 `(await import('/js/core/hero.js')).heroShowCount()`，期望 `0`。再执行 `localStorage.setItem('autoLoadLastVideo','0')` 刷新，期望 `1`。
- [ ] **Step 8: 截图**：浅色、深色、375px 宽各一张首屏。
- [ ] **Step 9: 提交**

```bash
git add js/core/hero.js css/hero.css index.html js/core/shell.js js/core/store.js js/main.js
git commit -m "首屏：大标题、拖放区、手机框演示循环、能力卡片；点 logo 回首屏，可继续检查当前视频"
```

---

### Task 4: 首屏 Canvas 背景

**Files:**
- Create: `js/lib/hero-canvas.js`
- Modify: `js/core/hero.js`（`showHero` 时 `start`，`hideHero` 时 `stop`）、`css/hero.css`（`#heroCanvas` 绝对定位铺满首屏、`z-index: 0`，玻璃内容在其上）

**Interfaces:**
- Produces：`start(canvas: HTMLCanvasElement): void`、`stop(): void`、`isRunning(): boolean`
- 行为：4 团柔光（3 团灰白、1 团 `#C8F03C`），每团半径为画布短边的 35%–55%，以 0.02–0.05 画布宽 / 秒的速度沿李萨如轨迹漂移；品牌色那团向鼠标位置缓动（系数 0.04 / 帧）。DPR 上限 1.5；帧率上限 30（按时间戳跳帧）；`visibilitychange` 隐藏时暂停；深色模式下柔光用更暗的灰、品牌色团 `globalAlpha .55` 并加 `shadowBlur`；减少动态效果下只画一帧。`stop()` 取消 rAF、移除监听、清空画布。

- [ ] **Step 1: 写验证（改动前执行应失败）**：

```js
const c = await import('/js/lib/hero-canvas.js');
const run1 = c.isRunning();
document.querySelector('#homeBtn').click(); await new Promise((r) => setTimeout(r, 300));
const run2 = c.isRunning();
document.querySelector('#heroContinue').click(); await new Promise((r) => setTimeout(r, 300));
[run1, run2, c.isRunning()]
```

在“有视频、工作台”状态下执行，期望 `[false, true, false]`。

- [ ] **Step 2: 实现 `hero-canvas.js`** 并接入 `hero.js`。
- [ ] **Step 3: 运行 Step 1 的验证**，期望 `[false, true, false]`。
- [ ] **Step 4: 性能检查**：首屏停留 10 秒，DevTools Performance 录制，确认主线程每帧脚本 < 4ms、帧率约 30。
- [ ] **Step 5: 截图**：浅色、深色首屏各一张（可见柔光透过玻璃）。
- [ ] **Step 6: 提交**

```bash
git add js/lib/hero-canvas.js js/core/hero.js css/hero.css
git commit -m "首屏 Canvas 背景：缓慢漂移的柔光，品牌色一团跟随鼠标；离开首屏、切后台时停止"
```

---

### Task 5: 进度阶段清单（`ui.js` 阶段 API）

**Files:**
- Modify: `index.html`（`#task` 里 `.task-row` 前加 `<ol id="taskStages" class="stages"></ol>`）
- Modify: `js/core/ui.js`、`css/shell.css`（`.stages` 样式）
- Modify: `js/lib/ffmpeg-tools.js`（新增导出 `ffmpegLoaded(mode)`）
- Modify: `js/core/media.js`

**Interfaces:**
- Produces（`js/core/ui.js`）：
  - `beginStages(): void` —— 清空 `#taskStages`，进入“阶段模式”。
  - `stage(name: string): void` —— 非阶段模式时什么也不做；否则：之前的当前阶段标为完成（`li.done`，前面的转圈变对勾 `drawStroke`），`name` 不在列表里就追加一个 `li`（`stagger` 进场），标为当前（`li.on`，转圈）。
  - `failStage(): void` —— 当前阶段标为 `li.err`（红色叉），退出阶段模式但保留列表。
  - `hideTask()` 改为：同时清空 `#taskStages` 并退出阶段模式。`showTask` 签名不变。
- Produces（`js/lib/ffmpeg-tools.js`）：`ffmpegLoaded(mode: 'st' | 'mt'): boolean`
- 分析阶段名（`media.js`，只在 `label === '原视频'` 时调用 `stage`）：`读取参数`、`加载 ffmpeg 核心`（仅 `!ffmpegLoaded(currentMode())` 时）、`补充探测帧率`、`分析声音`。`loadVideo` 在 `analyzeSlot` 前调用 `beginStages()`；`loadTestVideo` 不用阶段。

- [ ] **Step 1: 写验证（改动前执行应失败）**：首屏或工作台点“生成测试视频”，生成完开始分析后，在“分析声音”进行中执行

```js
[...document.querySelectorAll('#taskStages li')].map((li) => li.textContent.trim() + ':' + li.className)
```

期望形如 `["读取参数:done", "加载 ffmpeg 核心:done", "分析声音:on"]`（ffmpeg 已加载过时没有第二项）。分析完成后再执行，期望 `[]`。

- [ ] **Step 2: 实现阶段 API 与样式**：每行左侧 16px 圆圈（当前为品牌色转圈环、完成为品牌色实心对勾、出错为 `--fail` 叉），文字 13px；行间距 4px。
- [ ] **Step 3: `ffmpegLoaded` 与 `media.js` 接入**。
- [ ] **Step 4: 运行 Step 1 的验证**。
- [ ] **Step 5: 提交**

```bash
git add index.html js/core/ui.js css/shell.css js/lib/ffmpeg-tools.js js/core/media.js
git commit -m "进度改为阶段清单：读取参数 → 加载 ffmpeg → 补充探测帧率 → 分析声音，逐项打勾"
```

---

### Task 6: 导入与揭晓时刻（拖入光边、首屏过渡、扫描线、后台检查状态、结论揭晓）

**Files:**
- Modify: `js/core/shell.js`（拖入光边；后台检查状态）、`css/shell.css`（`.drag-glow`、`.scan`、`.steps button.busy`）
- Modify: `js/core/hero.js`（离开首屏的过渡）
- Modify: `js/core/ui.js`（新增 `setStepBusy`）
- Modify: `js/modules/occlusion/index.js`（`run()` 开始 / `finally` 调 `setStepBusy`）、`js/modules/cover/index.js`（`grabAt` 开始 / 结束调 `setStepBusy`）
- Modify: `js/modules/tech/report.js`、`js/modules/summary/index.js`、`css/tech.css`（结论区）
- Modify: `js/modules/tech/fix-dialog.js`（`done-head` 的图标）、`js/modules/occlusion/index.js:337`、`js/modules/cover/index.js:273`（结论图标换成 `verdictIcon`）

**Interfaces:**
- Consumes：`animate`、`reveal`、`countUp`、`stagger`、`drawStroke`、`flyFrom`、`DUR`、`SPRING`（Task 1）；`hideHero`（Task 3）。
- Produces（`js/core/ui.js`）：`lastTaskRect(): DOMRect | null` —— `hideTask()` 在隐藏 `#task` 前记录它的矩形（`#task` 当时不可见则记 `null`），供结论卡片“从进度区展开”。
- Produces（`js/core/ui.js`）：`setStepBusy(tab: 'occlusion' | 'cover', on: boolean): void` —— 切换 `#mainTabs button[data-tab=tab]` 的 `busy` 类；`on` 由真变假时对该按钮的 `.count` 做一次 `animate(scale: [0.6, 1.15, 1])`。
- Produces（`js/core/ui.js`）：`verdictIcon(kind: 'pass' | 'warn' | 'fail'): string` —— 返回 `<span class="verdict-icon ${kind}"><svg viewBox="0 0 24 24">…</svg></span>`，pass 为对勾折线、warn 为竖线加点、fail 为叉；`report.js`、`summary/index.js`、`fix-dialog.js`、`occlusion`、`cover` 里现有的 `verdict-icon` 文字符号全部换成它。
- 揭晓 key：技术体检 `${o.file.name}|${o.file.size}|${state.platform}|${c.verdict}|${c.pending ? 1 : 0}`；总报告 `${o.file.name}|${o.file.size}|${state.platform}|${verdict}|${perModule.map(x => x.items ? x.items.length : '-').join(',')}`。
- 结论区数字：`verdict-meta` 里三个计数包进 `<b class="vnum" data-n="${n}">`，揭晓时 `countUp`。

- [ ] **Step 1: 写验证（改动前执行应失败）**：载入一个有声音的视频，在“分析声音”进行中执行

```js
const sum = document.querySelector('#summary'), k0 = sum.dataset.revealKey;
await new Promise((r) => setTimeout(r, 1500));
[k0 !== undefined, sum.dataset.revealKey === k0]
```

期望 `[true, true]`（声音进度更新期间重渲染了多次，但 key 不变、不重播）。分析结束后执行

```js
const sum = document.querySelector('#summary');
[sum.dataset.revealKey.endsWith('|0'), [...sum.querySelectorAll('.vnum')].every((e) => e.textContent === e.dataset.n)]
```

期望 `[true, true]`。

- [ ] **Step 2: 拖入光边**：`dragenter` 时 `body.classList.add('dragging')`，`.drag-glow`（`position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 3px var(--brand), inset 0 0 60px var(--brand-glow)`，`opacity` 过渡 `var(--dur-fast)`）；拖放区 `scale(1.02)`；`drop` 时移除并对拖放区 `animate(scale: [0.97, 1])` 用 `SPRING.snappy`。
- [ ] **Step 3: 首屏 → 工作台过渡**：`hero.js` 在 `hideHero()` 前记录 `#heroDrop` 与三张 `.hero-cap` 的矩形，切换后 `flyFrom(dropRect, #mediaCard)`、三张卡片矩形分别 `flyFrom` 到 `#mainTabs` 前三个按钮、`.right` 做 `animate({ opacity: [0, 1], y: [24, 0] }, SPRING.soft)`，总时长约 `DUR.emph`。只在“首屏 → 载入视频”时播放，“继续检查”只做淡入。
- [ ] **Step 4: 扫描线**：`#mediaCard .player` 内追加 `<div class="scan">`，`state.busy` 时显示；CSS keyframes `translateY(0 → 210px)` 往返 2.4 秒，线高 2px `--brand`，下方 40px 渐变拖尾 `--brand-glow → transparent`；减少动态效果下隐藏。
- [ ] **Step 5: 后台检查状态**：实现 `setStepBusy` 并接入 occlusion / cover；`.steps button.busy .step-ico` 外加一个 `::after` 旋转环（2px `--brand` 顶边，0.9 秒一圈）。
- [ ] **Step 6: 结论揭晓**：`report.js` 与 `summary/index.js` 渲染后 `reveal(容器, key, run)`；`run` 依次：技术体检结论区在 `lastTaskRect()` 非空时 `flyFrom(lastTaskRect(), #summary)`，否则 `animate({ opacity: [0, 1], scale: [0.96, 1] })`、`drawStroke` 结论图标、三个 `.vnum` `countUp`、问题列表 `stagger`（技术体检 `#issueList > *`、总报告 `.sum-item`）。总报告所有时长减半（`stagger` 的 `gap 0.02`，`countUp` `duration 0.4`）。
- [ ] **Step 7: 运行 Step 1 的验证**，期望如上。
- [ ] **Step 8: 录屏检查**：从首屏拖入视频到结论揭晓完整录一遍（深色），确认过渡连贯、无重播、无闪烁。
- [ ] **Step 9: 提交**

```bash
git add js/ css/
git commit -m "导入与揭晓动效：拖入光边、首屏飞入工作台、扫描线、后台检查转圈、结论描边 + 数字滚动 + 列表依次出现"
```

---

### Task 7: 一键修复动效（弹窗展开、阶段清单、完成翻转、参数变化、下载脉冲）

**Files:**
- Modify: `js/modules/tech/fix-dialog.js`、`js/modules/tech/fixes.js`、`js/core/shell.js`（参数旧值 → 新值动画）、`css/tech.css`

**Interfaces:**
- Consumes：`beginStages`、`stage`、`failStage`（Task 5）；`animate`、`flyFrom`、`stagger`、`pulse`、`SPRING`（Task 1）；`verdictIcon`（Task 6）。
- 修复阶段名（`fixes.js`）：`检查处理方式`（`showTask('检查处理方式…')` 处）、`处理声音`（`l1`）、`编码视频`（`l2`，含重新编码）、`合并音视频`（`l3`）、`处理中（ffmpeg.wasm）`（退回 ffmpeg 时）、`复检`（`analyzeSlot(state.fixed, '处理后')` 前）、`截取对比画面`（`captureFrames` 内 `showTask` 处）。`doProcess` 开头 `beginStages()`；`catch` 里 `failStage()`。
- 弹窗起点：`openFixDialog(focusId, originEl?: Element)` 新增第二个参数；调用方（`#openFix`、`.c-fix`、总报告“去修复”）传被点的按钮。

- [ ] **Step 1: 写验证（改动前执行应失败）**：用测试视频（有问题项）打开一键修复，开始处理，处理中执行

```js
[...document.querySelectorAll('#fixDialog #taskStages li')].map((li) => li.textContent.trim().split(':')[0] + ':' + li.className)
```

期望第一项为 `"检查处理方式:done"`，最后一项 `className` 为 `on`。完成后执行

```js
[document.querySelector('#fixDone .btn.primary.big').classList.contains('pulse') || document.querySelector('#fixDone .btn.primary.big').getAnimations().length > 0,
 document.querySelectorAll('#paramList .new').length > 0]
```

期望 `[true, true]`。

- [ ] **Step 2: 弹窗从按钮展开**：`openFixDialog` 在 `showModal()` 后若有 `originEl`，`flyFrom(originEl.getBoundingClientRect(), .dlg-box, { spring: SPRING.soft })`，同时 `opacity 0→1`；删除 `css/tech.css` 里的 `dlg-in` keyframes（无 `originEl` 时用 `animate({ opacity: [0, 1], y: [12, 0] })`）。
- [ ] **Step 3: 阶段清单接入 `fixes.js`**（阶段名见 Interfaces）。
- [ ] **Step 4: 完成翻转**：`renderDone()` 后，在 `#fixDone` 里列出变好的项（`before` 为 warn/fail、`after` 为 pass），每项一个状态标签，先显示旧标签，`stagger` 间隔 0.12 秒逐个 `animate({ rotateX: [0, 90] })` → 换成 `badge('pass')` → `animate({ rotateX: [-90, 0] })`；之后对下载大按钮 `pulse()`。只在 `view` 从 `running` 变 `done` 时播放一次。
- [ ] **Step 5: 参数旧值 → 新值**：`shell.js` 的 `renderLeft` 在 `state.fixed` 首次出现（记在模块变量 `lastFixedUrl`）时，对 `#paramList .old` 做 `animate({ opacity: [1, .5] })` 并加删除线过渡（CSS `text-decoration-color` 从透明到 `--subtle`），`.new` 做 `stagger`。
- [ ] **Step 6: 失败 / 取消验证（Review Focus 4）**：处理中点“取消”，期望 `#taskStages li.err` 恰好 1 个、`#fixDone` 隐藏、弹窗回到选择修复项、没有元素带 `pulse` 类。
- [ ] **Step 7: 运行 Step 1 的验证**。
- [ ] **Step 8: 录屏检查**：深色模式下完整录一次修复流程。
- [ ] **Step 9: 提交**

```bash
git add js/modules/tech/fix-dialog.js js/modules/tech/fixes.js js/modules/summary/index.js js/modules/tech/report.js js/core/shell.js css/tech.css
git commit -m "一键修复动效：弹窗从按钮展开、处理阶段逐项打勾、完成后问题翻转为通过、参数变化动画、下载按钮光晕"
```

---

### Task 8: 全局小动效（步骤滑块、面板切换、分段控件、按钮回弹）

**Files:**
- Modify: `js/core/shell.js`（`renderTabs`）、`css/shell.css`、`css/base.css`
- Create: `js/core/seg-slider.js`

**Interfaces:**
- Consumes：`animate`、`SPRING`（Task 1）
- Produces：`attachSegSlider(container: Element, selector: string): () => void` —— 在容器内插入一个 `.seg-thumb` 绝对定位块（`left: 0; top: 0`），用 `MutationObserver` 观察子元素 `class` 变化，把 thumb 移到当前 `.on` 元素上。只改 `transform`：thumb 的 `width` / `height` 直接设为目标尺寸（不做动画），位置用 `x` / `y` 平移以 `SPRING.snappy` 动画；容器尺寸变化（`ResizeObserver`）时无动画重新定位。返回解绑函数。用于 `#mainTabs`（选择器 `button[data-tab]`，纵向时用 `y` + `scaleY`）、`#platformSeg`、`#techTabs`、`#previewSeg`、`#coverSrcSeg`、`#coverEditSeg`、`#occSrcSeg`。
- `.steps button.on` 与 `.seg button.on` 的背景和阴影移到 `.seg-thumb` 上（按钮本身 `.on` 只改文字颜色）。

- [ ] **Step 1: 写验证（改动前执行应失败）**：

```js
const t = document.querySelector('#mainTabs .seg-thumb');
const y0 = t && new DOMMatrix(getComputedStyle(t).transform).m42;
document.querySelector('#mainTabs button[data-tab=summary]').click();
await new Promise((r) => setTimeout(r, 700));
[!!t, new DOMMatrix(getComputedStyle(t).transform).m42 > y0]
```

期望 `[true, true]`。

- [ ] **Step 2: 实现 `seg-slider.js`** 并接入上述控件（`mountShell` 和各模块 `mount` 里调用）。
- [ ] **Step 3: 面板切换**：`renderTabs` 在 `state.tab` 变化时对新显示的 `[data-panel]` 与 `.panel-title` 做 `animate({ opacity: [0, 1], y: [8, 0] }, { duration: DUR.base, ease: EASE })`。
- [ ] **Step 4: 按钮回弹**：`.btn:active` 保持 `scale(.97)`，`.btn` 的 `transition` 改为 `transform var(--dur-fast) cubic-bezier(.34, 1.56, .64, 1)`（回弹曲线）。
- [ ] **Step 5: 运行 Step 1 的验证**；窄屏（横向步骤导航）下再执行一次，把 `m42` 换成 `m41`。
- [ ] **Step 6: 提交**

```bash
git add js/core/seg-slider.js js/core/shell.js js/modules/ css/
git commit -m "全局小动效：步骤导航和分段控件的选中块滑动、切换步骤淡入、按钮回弹"
```

---

### Task 9（可选）: 对比页拖动分隔线

**Files:**
- Modify: `js/modules/tech/compare.js`（`#frameCompare` 渲染）、`css/tech.css`、`index.html`（`画面` 小标题的说明改为“同一时间点截帧 · 拖动分隔线对比处理前后”）

**Interfaces:**
- 每个 `.frame-pair` 改为 `<div class="frame-cmp" style="--pos: 50%">`：底层处理后图片，上层处理前图片用 `clip-path: inset(0 calc(100% - var(--pos)) 0 0)`，分隔线 `.frame-handle`（2px 宽 `--brand` 线 + 28px 圆形手柄）`left: var(--pos)`。`pointerdown` 后 `setPointerCapture`，`pointermove` 按位置写 `--pos`（0%–100%）；键盘：手柄 `tabindex="0"`，左右方向键每次 5%。左上角标“处理前”、右上角标“处理后”。处理前后截帧尺寸不同时（例如横转竖），保留原来的左右并排显示。

- [ ] **Step 1: 写验证（改动前执行应失败）**：有处理结果时进入「对比」，执行

```js
const c = document.querySelector('.frame-cmp'), h = c.querySelector('.frame-handle');
h.focus(); h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
c.style.getPropertyValue('--pos')
```

期望 `"55%"`。

- [ ] **Step 2: 实现**。
- [ ] **Step 3: 运行 Step 1 的验证**；鼠标拖动、375px 宽下触摸拖动各试一次。
- [ ] **Step 4: 提交**

```bash
git add js/modules/tech/compare.js css/tech.css index.html
git commit -m "对比页：截帧改为可拖动分隔线对比处理前后"
```

---

### Task 10: 文档与总体验证

**Files:**
- Modify: `README.md`（“使用”一节开头的界面描述：改为“Apple 液态玻璃风格，黑白灰 + 霓虹柠檬品牌色，跟随系统浅色 / 深色”；补充首屏和点 logo 回首屏；第三方库列表加 Motion；“已知限制”里补一句“界面动效依赖 `vendor/motion/`，缺失时没有动画但功能正常”）
- Modify: `docs/superpowers/plans/2026-10-30-perf-baseline.md`（追加“改动后”列）

- [ ] **Step 1: 更新 README**。
- [ ] **Step 2: 性能对比**：按 Task 0 的方法用同一视频再测两次，填入基线文件；期望每一项平均耗时增幅 ≤ 5%。超出时在 Performance 面板里找出原因并修复后重测。
- [ ] **Step 3: 全面检查**（每项截图或录屏）：首屏（浅 / 深 / 375px）；导入 → 揭晓全流程；总报告揭晓；一键修复成功与取消；对比分隔线；系统开启“减少动态效果”后再走一遍全流程（期望无扫描线、无 Canvas 动画、数字直接显示）；Motion 文件改名后走一遍（期望功能正常）；校准页、许可页外观。
- [ ] **Step 4: 打包检查**：运行 `bash scripts/package.sh`，确认 `dist/web/vendor/motion/motion.js` 存在。
- [ ] **Step 5: 提交**

```bash
git add README.md docs/superpowers/plans/2026-10-30-perf-baseline.md
git commit -m "README 更新界面说明；记录动效改造后的性能对比"
```
