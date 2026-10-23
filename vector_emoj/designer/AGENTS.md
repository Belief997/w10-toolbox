<!-- BEGIN HoneyGUI AI 设计指南（自动维护，请勿编辑本区块） -->

# HoneyGUI 项目 — AI 设计指南

> 用任意 AI agent（Claude Code / Cursor / Codex / Copilot / Trae 等）生成或修改本项目的
> HML 界面时，请先 `@` 引用本文件；Claude Code 还会自动加载 honeygui-designer skill。

## 生成 HML 前必读完整规范

`.claude/skills/honeygui-designer/references/hml-spec.md`

（该文件由扩展按当前项目引擎自动维护，顶部注明了 targetEngine 与各组件可用性。）

## 不读规范也必须守的底线

- 只用规范中标注当前 targetEngine 为 ready(✓) 的组件；unsupported 一律勿用。
- `hg_view` 不可嵌套；非容器组件不可有子组件。
- 图像路径（`src`/`imageOn`/`imageOff`）以 `assets/` 开头，如 `assets/icon.png`；字体 `fontFile` 以 `/` 开头，如 `/NotoSansSC-Medium.ttf`。`hg_label` 必须有 `fontFile`，且字体须在 assets/ 中。
- 事件用 `<events><event><action>` 结构，不用内联 `onXxx` 属性。
- 尺寸用 `width`/`height`（不是 `w`/`h`）；对齐用 `hAlign`/`vAlign`（不是 `textAlign`）。
- 绝不存在、永远勿用的组件：`hg_container`、`hg_grid`、`hg_tab`。

## 生成后必做（验证闭环）

调用 Extension HTTP API 验证（设计器运行时监听 38912）：

```bash
curl -X POST http://localhost:38912/api/validate-hml \
  -H "Content-Type: application/json" \
  -d '{"filePath":"ui/xxx.hml"}'
```

修复所有 errors 后再继续。注意：验证器只查结构规则，**不校验组件白名单 / 属性名**，
`valid:true` 仅必要不充分——仍须对照 hml-spec.md 人工核对组件在当前引擎可用、属性名正确。

## 看效果（仿真）

在 VSCode 中打开本项目（已安装 HoneyGUI Visual Designer 扩展）：
点击 HoneyGUI 侧边栏的 **Simulate（🚀）**，或命令面板执行 `HoneyGUI: Simulate`，
扩展会自动完成 codegen → SCons 编译 → 仿真器运行。

<!-- END HoneyGUI AI 设计指南 -->
