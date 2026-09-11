# 读伴 ReaDouble

Rokid Glasses 上的读论文陪伴智能体（AIUI 0.17.0，单绿显示）。看英文论文时有一段看不懂，双击镜腿唤起 AIUI，说“这段什么意思”：眼镜先拍下视野里的段落，多模态大模型识别文字并给出中文解读，朗读出来；之后单击镜腿就能语音追问、翻译、总结或重拍。

## 眼镜画布与比例

| 层 | 尺寸 | 来源 |
| --- | --- | --- |
| 光学画布（整个显示区） | 480 × 640 px，3:4 竖屏 | AIUI Studio 1.1.0 真机模拟的 `.device-screen`（`width: 480px; height: 640px`，界面里缩放 0.75 显示），与官方光学设计指南一致 |
| AIUI 页面视口（Page 实际渲染区） | 480 × 352 px，15:11 横向 | 同一模拟器里的 `.ink-canvas-host`（`top: 144px; width: 480px; height: 352px`，垂直居中），与 0.17 附带的单绿设计规范 `design/monochrome/design-system-green.md` 的参考画布一致 |
| 安全区 | 左右 16 px、上下 12 px，内容宽 448 px | 设计规范 |
| 对话流内联卡片 | 约 448 × 150 px | 上一个项目 doubletraining 在模拟器里的实测 |

页面按 480 × 352 布局；高度不足 240 px 时（内联卡片）只保留状态、解读正文和操作提示。

## 导入 AIUI Studio

AIUI 工程根是仓库里的 `agent/` 子目录（它直接包含 `app.json`），不是仓库根：

```text
Repository: https://github.com/cnYui/readouble
Ref: main
AIUI project directory: agent
```

Studio 左上角「新建智能体」→「GitHub 导入」填：`https://github.com/cnYui/readouble/tree/main/agent`，导入后在项目「···」菜单选「上传云端」，再在对话框发送 `/debug` 进入真机模拟。

## 交互流程

```text
对话里提问 ──► 解读 Page 打开 ──► 自动拍照 ──► 识别 + 解读（LanguageModel，图片+文字）──► 显示三段 + 朗读【解读】
                                    │ 宿主要求用户操作                                       │ 单击
                                    ▼                                                        ▼
                              单击镜腿再拍                                      语音追问 / 翻译一下 / 总结一下 / 重拍 / 结束
```

| 状态 | 单击 | 向前 / 向后滑动 |
| --- | --- | --- |
| 准备拍照（READY） | 拍照 | — |
| 拍照中 / 解读中 | 忽略 | 解读中可翻看已到达的内容 |
| 解读完成（DONE） | 开始语音追问 | 翻看解读（每次 120 px） |
| 聆听中（LISTEN） | 结束听写并发送 | — |
| 出错（ERROR） | 相机不可用 → 念出这段文字；模型失败 → 重试；语音失败 → 再试一次 | — |

双击由宿主处理（进入或退出全屏）；返回键不拦截，离开页面时会停止听写、朗读和相机。

## 页面输出

大模型被要求按三段回答，页面把它们拆开显示：

- 【原文】不超过两句的关键原文摘录（48% 亮度，左侧 1 px 引线）
- 【解读】中文说明，120 字以内，会被朗读
- 【术语】最多 3 个“术语：一句话解释”

模型没有按格式回答时（例如照片太糊），整段文字作为解读显示。

## 目录

```text
agent/                     AIUI Studio 导入根（AIUI 0.17.0）
  AGENTS.md                智能体身份、语音路由规则、能力边界
  app.json                 pages: explain；permissions: CAMERA, RECORD_AUDIO
  pages/explain/index.ink  解读页（拍照 → 识别解读 → 朗读 → 语音追问）
  lib/reply.js             纯逻辑：输入归一化、提示词、回答解析、口令识别、照片编码
  lib/temple.js            镜腿输入去重（来自 doubletraining）
  aiui-audit-claims.json   审计声明
tests/                     Node 单元测试与页面逻辑测试（不进 Studio）
docs/aiui-audit.md         UX / 能力审计矩阵
```

## 开发

```bash
npm test
npm run validate
```

需要 Node 20+。`tests/page.test.js` 会把 `.ink` 里的 `<script setup>` 当作真实模块加载，用假的相机、模型、语音识别和朗读跑完整个状态机。

## 已知边界

- 自动拍照依赖宿主是否把“语音打开页面”算作有效的用户操作；被拒绝时页面回到“需要你按一下”，单击镜腿再拍。
- 第一轮（图片 + 问题）用 `session.prompt()` 一次性返回（官方 chat 示例的用法），追问用 `promptStreaming()` 流式显示。
- 追问是否需要 `RECORD_AUDIO` 权限尚未在真机验证；清单里已按“真实使用麦克风”申报。
- 模拟器结论不等于真机通过；真机的光学、按键顺序、权限弹窗和性能都还没有验证。
