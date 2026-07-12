# 前端开发文档

本文档描述项目前端开发的技术栈、规范和最佳实践。

## 技术栈

### 核心框架
- **运行环境**: Chrome Extension
- **语言**: JavaScript / TypeScript
- **UI 框架**: [待补充: React / Vue / 原生]

### 构建工具
- **打包工具**: [待补充: Webpack / Vite / Rollup]
- **CSS 处理**: [待补充: CSS Modules / Styled Components / Tailwind]
- **代码检查**: ESLint + Prettier

### 测试工具
- **单元测试**: [待补充: Jest / Vitest]
- **E2E 测试**: [待补充: Playwright / Cypress]

## 项目结构

```
project/
├── src/
│   ├── manifest.json       # 扩展配置
│   ├── background.js       # 后台脚本
│   ├── content.js          # 内容脚本
│   ├── popup/              # 弹出页面
│   ├── options/            # 选项页面
│   ├── components/         # 共享组件
│   ├── utils/              # 工具函数
│   ├── assets/             # 静态资源
│   └── styles/             # 样式文件
├── public/
│   └── icons/              # 扩展图标
├── tests/
│   ├── unit/
│   └── e2e/
├── package.json
└── [配置文件]
```

## 代码规范

### 命名约定

#### 文件命名
- 组件: PascalCase (例如: `Button.jsx`)
- 工具函数: camelCase (例如: `formatDate.js`)
- 样式文件: 与组件同名 (例如: `Button.css`)

#### 变量命名
```javascript
// 常量: UPPER_SNAKE_CASE
const MAX_RETRY_COUNT = 3;

// 变量/函数: camelCase
const userName = 'John';
function formatDate(date) {}

// 类/组件: PascalCase
class UserService {}
function Button() {}

// 私有属性/方法: _前缀
this._privateMethod = function() {};
```

### 代码风格

#### 缩进和空格
- 使用 2 空格缩进
- 运算符两侧加空格
- 逗号后加空格

#### 引号
- 优先使用单引号
- JSX 中使用双引号

#### 分号
- [待补充: 使用/不使用分号]

### 注释规范

#### 单行注释
```javascript
// 这是单行注释
const name = 'value';
```

#### 多行注释
```javascript
/**
 * 函数说明
 * @param {string} param - 参数说明
 * @returns {boolean} 返回值说明
 */
function checkValid(param) {
  return true;
}
```

#### TODO 注释
```javascript
// TODO: 待实现的功能
// FIXME: 需要修复的问题
// HACK: 临时解决方案
```

## 组件开发

### 组件原则

1. **单一职责**: 每个组件只做一件事
2. **可复用性**: 组件应该可复用
3. **可测试性**: 组件应该易于测试
4. **性能优化**: 避免不必要的渲染

### 组件模板

```javascript
/**
 * Button 组件
 * @param {Object} props
 * @param {string} props.type - 按钮类型
 * @param {string} props.size - 按钮大小
 * @param {Function} props.onClick - 点击回调
 */
function Button({ type = 'primary', size = 'medium', onClick, children }) {
  return (
    <button
      className={`btn btn-${type} btn-${size}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
```

### 状态管理

[待补充状态管理方案]

## Chrome Extension API

### 常用 API

#### 存储
```javascript
// 保存数据
chrome.storage.local.set({ key: value });

// 读取数据
chrome.storage.local.get(['key'], (result) => {
  console.log(result.key);
});

// 监听变化
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.key) {
    console.log('Key changed:', changes.key);
  }
});
```

#### 消息通信
```javascript
// 发送消息
chrome.runtime.sendMessage({ type: 'ACTION', data: payload });

// 接收消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'ACTION') {
    // 处理消息
    sendResponse({ success: true });
  }
});
```

#### 标签页
```javascript
// 获取当前标签页
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
});

// 创建新标签页
chrome.tabs.create({ url: 'https://example.com' });
```

#### 右键菜单
```javascript
// 创建右键菜单
chrome.contextMenus.create({
  id: 'menu-id',
  title: '菜单项',
  contexts: ['selection']
});

// 监听菜单点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'menu-id') {
    // 处理点击
  }
});
```

## 性能优化

### 加载优化
- 懒加载非关键资源
- 代码分割
- 资源预加载
- 压缩资源文件

### 运行时优化
- 虚拟列表
- 防抖和节流
- 缓存计算结果
- 避免内存泄漏

### 扩展优化
- 减少后台脚本
- 按需注入内容脚本
- 合理使用持久化存储
- 避免频繁的存储操作

## 调试技巧

### Chrome DevTools
```javascript
// console 方法
console.log('普通日志');
console.warn('警告');
console.error('错误');
console.table([{ id: 1, name: 'test' }]);
console.time('timer');
// ... 代码
console.timeEnd('timer');
```

### 扩展调试
- background.js: `chrome://extensions` 点击 "背景页"
- content.js: 页面开发者工具
- popup: 右键弹窗选择 "检查"

## 测试

### 单元测试

[待补充测试框架配置]

```javascript
describe('Button', () => {
  it('should render correctly', () => {
    // 测试代码
  });
});
```

### E2E 测试

[待补充测试配置]

## 发布流程

### 版本号规范
- 遵循语义化版本 (SemVer)
- 格式: MAJOR.MINOR.PATCH
- 示例: 1.0.0 → 1.0.1 (修复) → 1.1.0 (新功能) → 2.0.0 (重大更新)

### 发布步骤
1. 更新版本号
2. 更新 CHANGELOG
3. 构建生产版本
4. 测试验证
5. 上传到 Chrome Web Store
6. 提交审核

## 参考资源

- [Chrome Extension 文档](https://developer.chrome.com/docs/extensions/)
- [设计系统](DESIGN.md)
- [架构文档](../ARCHITECTURE.md)

## 更新日志

- [待补充] 初始化前端开发文档