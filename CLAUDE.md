# 读伴 ReaDouble — Rokid AIUI 读论文陪伴智能体（工作区说明）

> 给 Claude 的说明文件。本文件夹是 `cnYui/readouble` 仓库的根目录；AIUI Studio 的导入根是其中的 `agent/` 子目录。

## 目录关系

| 位置 | 是什么 |
|---|---|
| 本文件夹 | Git 仓库根，GitHub：`https://github.com/cnYui/readouble`（公开，`main`） |
| `agent/` | **AIUI Studio 导入根**（直接含 `app.json`），AIUI 0.17.0，一个 Page：`pages/explain/index` 解读页 |
| `agent/lib/` | 纯逻辑：`reply.js`（输入归一化、提示词、三段回答解析、口令识别、Base64 / data URL）、`temple.js`（镜腿输入去重） |
| `tests/` | Node 测试（`npm test`，Node 20+），`page.test.js` 直接加载 `.ink` 的 `<script setup>` 跑状态机；不进 Studio |
| `docs/aiui-audit.md` | Skill 要求的 UX / 能力审计矩阵 |
| `C:\Users\yui\.claude\skills\rokid-aiui-agent` | 已安装的 Skill，校验脚本在 `scripts/` |

## 改代码 → Studio 调试的循环

1. 本地改 `agent/`，跑 `npm test` 和 `npm run validate`（strict 校验）。
2. `git commit` + `git push origin main`。
3. Studio（`https://aiui.rokid.com`）左上「新建智能体」整个按钮打开下拉 →「GitHub 导入」→ 填 `https://github.com/cnYui/readouble/tree/main/agent` →「确认导入」。同一地址再导入会就地更新。
4. 项目「···」菜单 →「上传云端」。
5. 对话框发 `/debug 模拟眼镜设备运行解读页面 pages/explain/index`（`/debug` 会变成标签，要点发送按钮）→ 卡片上点「进入」→ 画布进右上「效果预览」（480 × 352）。
6. 右侧「真机模拟」：镜腿四个按钮、语音输入、摄像头；「日志」面板显示页面的 `console.log('[readouble] …')`。

## 模拟器里的输入映射（Studio 1.1.0，沿用 doubletraining 的实测）

每个镜腿操作都先发 `GlobalHook`（keydown+keyup），再发手势键：单击 → `Enter`，向前滑动 → `ArrowUp`，向后滑动 → `ArrowDown`；双击不会送到智能体页面（宿主处理）。`lib/temple.js` 让紧跟手势键的 `GlobalHook` 失效，单独出现的 `GlobalHook` 延迟 280 ms 当作一次单击。

## 页面状态机（`_phase`）

`ready` → 单击拍照 → `capturing` → `reading`（`session.prompt` 图片+问题）→ `answered` → 单击 → `listening`（`SpeechRecognition`）→ 口令或追问 → `reading`（`promptStreaming`）→ `answered`。相机被拒 / 不可用 → `error(camera)` → 单击 → 听写替代。任何异步结果都带 turn id，`onHide` 会把 turn 作废并停止听写、朗读、相机。

## Studio 运行时的坑（来自 doubletraining，别改回去）

- QuickJS，时区 UTC；`<page>` 根节点上的动态类不生效（面板用 `panel {{panelX}}` 的普通 view 切换）；`ink:for` 一律写成 `<block ink:for … ink:for-item="x">` 包住内层元素；被 `ink:if` 销毁重建的块里 `ink:for` 不再渲染，所以四个面板常驻、用 `on` 类显示。
- 浏览器面板收起时页面完全停摆，导入和效果预览都不动；测试时面板必须显示。
- 「进入」后的效果预览仍是 `_current`，只是 480 × 352；紧凑布局按 `@media (max-height: 240px)` 切换。
- 草稿态智能体的槽位抽取在模拟器里不生效（`/debug` 打开的页面拿不到 `question`），页面因此必须能在没有 query 时工作。

## 已验证 / 未验证

见 README「已知边界」和 `docs/aiui-audit.md`。模拟器结论 ≠ 真机通过。
