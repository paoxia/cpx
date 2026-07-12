# 设计文档

本文档概述项目的设计理念和视觉规范。

## 设计理念

### 核心原则

1. **简洁至上**
   - 移除不必要的元素
   - 专注于核心功能
   - 清晰的视觉层次

2. **用户优先**
   - 直观的交互方式
   - 流畅的用户体验
   - 即时的反馈机制

3. **一致性**
   - 统一的视觉语言
   - 可预测的行为
   - 协调的设计元素

4. **可访问性**
   - 所有人可用
   - 清晰的对比度
   - 合适的交互区域

## 视觉规范

### 配色方案

#### 主色调
- **Primary**: 系统主色，用于主要操作和强调
- **Secondary**: 次要色，用于辅助元素
- **Accent**: 强调色，用于特殊提示

#### 功能色
- **Success**: 成功状态
- **Warning**: 警告状态
- **Error**: 错误状态
- **Info**: 信息状态

#### 中性色
- 用于文本、背景、边框等基础元素

### 字体规范

#### 字体族
```
Primary: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto
Monospace: "SF Mono", Monaco, Consolas, "Courier New"
```

#### 字体层级
- **Display**: 34px - 特大标题
- **Title**: 28px - 页面标题
- **Heading**: 22px - 区块标题
- **Body**: 17px - 正文文本
- **Caption**: 12px - 说明文本

### 间距系统

基于 8px 网格系统：
```
4px   - 极小间距
8px   - 基础间距
16px  - 标准间距
24px  - 宽松间距
32px  - 区块间距
48px  - 大区块间距
```

### 圆角规范

```
4px   - 小元素
8px   - 卡片、按钮
12px  - 大卡片
16px  - 模态框
Full  - 标签、徽章
```

### 阴影层级

```
Level 1: 轻微阴影，悬停状态
Level 2: 标准阴影，卡片元素
Level 3: 明显阴影，弹窗元素
```

## 组件设计

### 按钮

#### 样式变体
- **Primary**: 主要操作，填充背景
- **Secondary**: 次要操作，描边样式
- **Text**: 文本按钮，无背景
- **Icon**: 图标按钮，圆形/方形

#### 尺寸规范
- **Small**: 32px 高度，紧凑布局
- **Medium**: 40px 高度，标准布局
- **Large**: 48px 高度，强调操作

#### 状态
- Normal: 默认状态
- Hover: 悬停状态
- Pressed: 按下状态
- Disabled: 禁用状态
- Loading: 加载状态

### 输入框

#### 规范
- 高度: 40px
- 边框: 1px solid
- 圆角: 8px
- 内边距: 12px

#### 状态
- Normal: 默认状态
- Focus: 聚焦状态，蓝色边框
- Error: 错误状态，红色边框
- Disabled: 禁用状态，灰色背景

### 卡片

#### 规范
- 背景: 白色
- 圆角: 12px
- 阴影: Level 2
- 内边距: 16px

### 导航

#### 顶部导航
- 高度: 56px
- 背景: 半透明模糊
- 内容: 居中或两侧分布

#### 侧边导航
- 宽度: 240px (展开) / 64px (折叠)
- 图标大小: 24px
- 文字大小: 14px

## 动效设计

### 时长规范
```
Fast:    150ms - 微交互
Normal:  300ms - 标准动画
Slow:    500ms - 复杂动画
```

### 缓动函数
```
Ease:        cubic-bezier(0.25, 0.1, 0.25, 1)
Ease-in:     cubic-bezier(0.42, 0, 1, 1)
Ease-out:    cubic-bezier(0, 0, 0.58, 1)
Ease-in-out: cubic-bezier(0.42, 0, 0.58, 1)
```

### 常用动画
- 淡入淡出: opacity 变化
- 滑入滑出: translate 变化
- 缩放: scale 变化
- 展开/收起: height 变化

## 响应式设计

### 断点定义
```
Mobile:    < 640px
Tablet:    640px - 1024px
Desktop:   > 1024px
Wide:      > 1440px
```

### 布局原则
- 移动优先设计
- 流式布局
- 灵活的网格系统
- 合理的间距调整

## 无障碍设计

### 对比度要求
- 文本: 至少 4.5:1
- 大文本: 至少 3:1
- UI 组件: 至少 3:1

### 交互规范
- 最小点击区域: 44x44px
- 键盘导航支持
- 焦点可见性
- 屏幕阅读器支持

## 深色模式

### 切换策略
- 跟随系统设置
- 用户手动切换
- 记住用户偏好

### 颜色映射
- 亮色模式背景 → 深色模式背景
- 保持品牌色一致性
- 确保对比度符合要求

## 图标设计

### 图标库
- 推荐: SF Symbols (Apple)
- 备选: Heroicons, Phosphor Icons
- 风格: 线性或填充，保持一致

### 图标规范
- 标准尺寸: 16px, 24px, 32px
- 描边宽度: 1.5px
- 圆角: 与整体风格一致

## 参考资源

- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/)
- [Material Design](https://material.io/design)
- [设计系统参考](references/design-system-reference-llms.txt)

## 更新日志

- [待补充] 初始化设计文档