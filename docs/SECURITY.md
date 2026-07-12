# 安全文档

本文档描述项目的安全策略、措施和最佳实践。

## 安全原则

### 核心原则

1. **最小权限**: 只授予必要的最小权限
2. **纵深防御**: 多层安全防护措施
3. **安全默认**: 默认配置应该是安全的
4. **失败安全**: 失败时进入安全状态

### 安全目标

- 保护用户数据安全
- 防止未授权访问
- 确保系统可用性
- 合规性要求

## 威胁模型

### 1. 数据威胁

| 威胁类型 | 描述 | 影响 | 缓解措施 |
|----------|------|------|----------|
| 数据泄露 | 敏感数据被未授权访问 | 高 | 加密、访问控制 |
| 数据篡改 | 数据被恶意修改 | 高 | 完整性校验 |
| 数据丢失 | 数据意外丢失 | 高 | 备份、冗余 |

### 2. 隐私威胁

| 威胁类型 | 描述 | 影响 | 缓解措施 |
|----------|------|------|----------|
| 隐私泄露 | 用户隐私信息泄露 | 高 | 数据脱敏、匿名化 |
| 跟踪 | 用户行为被跟踪 | 中 | 隐私保护机制 |

### 3. 功能威胁

| 威胁类型 | 描述 | 影响 | 缓解措施 |
|----------|------|------|----------|
| XSS | 跨站脚本攻击 | 高 | 输入验证、输出编码 |
| CSRF | 跨站请求伪造 | 中 | Token 验证 |
| 注入 | 代码/命令注入 | 高 | 参数化查询 |

## Chrome Extension 安全

### 1. 权限管理

#### 权限声明
```json
{
  "permissions": [
    "storage",      // 仅申请必要权限
    "activeTab"     // 优先使用 activeTab
  ],
  "optional_permissions": [
    // 可选权限，按需申请
  ]
}
```

#### 权限原则
- 申请最小必要权限
- 使用 optional_permissions
- 运行时申请权限
- 说明权限用途

### 2. 内容安全

#### 内容安全策略 (CSP)
```json
{
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

#### 安全实践
- 不使用 eval()
- 不使用 innerHTML
- 不加载外部脚本
- 使用 HTTPS

### 3. 数据安全

#### 存储安全
```javascript
// 敏感数据加密后存储
async function saveSecureData(key, data) {
  const encrypted = await encrypt(data);
  await chrome.storage.local.set({ [key]: encrypted });
}

// 读取时解密
async function getSecureData(key) {
  const result = await chrome.storage.local.get(key);
  return await decrypt(result[key]);
}
```

#### 数据清理
```javascript
// 退出时清理敏感数据
chrome.windows.onRemoved.addListener((windowId) => {
  chrome.storage.local.remove(['sensitive_key']);
});
```

### 4. 消息安全

#### 消息验证
```javascript
// 接收消息时验证来源
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 验证消息来源
  if (!sender.id || sender.id !== chrome.runtime.id) {
    console.warn('Invalid message source');
    return;
  }

  // 验证消息格式
  if (!isValidMessage(message)) {
    console.warn('Invalid message format');
    return;
  }

  // 处理消息
  handleMessage(message, sendResponse);
});
```

#### 消息类型定义
```javascript
const MESSAGE_TYPES = {
  ACTION_1: 'action_1',
  ACTION_2: 'action_2'
};

function isValidMessage(message) {
  return message &&
    typeof message.type === 'string' &&
    Object.values(MESSAGE_TYPES).includes(message.type);
}
```

## 输入验证

### 1. 验证原则

- **验证所有输入**: 不信任任何外部输入
- **白名单验证**: 使用白名单而非黑名单
- **严格验证**: 验证数据类型、长度、格式
- **及时清理**: 验证失败立即拒绝

### 2. 验证实现

#### 字符串验证
```javascript
function validateString(input, options = {}) {
  const {
    minLength = 0,
    maxLength = 1000,
    pattern = null,
    required = false
  } = options;

  if (!input) {
    return !required;
  }

  if (typeof input !== 'string') {
    return false;
  }

  if (input.length < minLength || input.length > maxLength) {
    return false;
  }

  if (pattern && !pattern.test(input)) {
    return false;
  }

  return true;
}
```

#### URL 验证
```javascript
function validateURL(url) {
  try {
    const parsed = new URL(url);
    // 只允许 HTTPS
    if (parsed.protocol !== 'https:') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

### 3. 输出编码

#### HTML 编码
```javascript
function escapeHTML(str) {
  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return str.replace(/[&<>"']/g, char => escapeMap[char]);
}
```

#### JavaScript 编码
```javascript
function escapeJS(str) {
  return str.replace(/[\\'"]/g, char => '\\' + char);
}
```

## XSS 防护

### 1. 防护措施

- 输出编码
- CSP 策略
- 不使用危险 API
- 使用安全的模板引擎

### 2. 危险模式

```javascript
// 危险: 直接插入 HTML
element.innerHTML = userInput;

// 危险: 使用 eval
eval(userInput);

// 危险: 动态执行代码
new Function(userInput);

// 安全: 使用 textContent
element.textContent = userInput;

// 安全: 使用安全的 API
element.setAttribute('data-value', userInput);
```

## CSRF 防护

### 1. Token 验证

```javascript
// 生成 Token
function generateToken() {
  return crypto.getRandomValues(new Uint8Array(16))
    .reduce((str, byte) => str + byte.toString(16), '');
}

// 存储 Token
async function storeToken(token) {
  await chrome.storage.local.set({ csrf_token: token });
}

// 验证 Token
async function validateToken(token) {
  const result = await chrome.storage.local.get('csrf_token');
  return result.csrf_token === token;
}
```

### 2. SameSite 属性

```javascript
// 设置 Cookie 的 SameSite 属性
document.cookie = 'session=xxx; SameSite=Strict; Secure';
```

## 数据保护

### 1. 敏感数据识别

| 数据类型 | 敏感级别 | 示例 |
|----------|----------|------|
| 高敏感 | 严重 | 密码、密钥、个人信息 |
| 中敏感 | 高 | 用户 ID、会话 Token |
| 低敏感 | 中 | 用户偏好、设置 |
| 公开 | 低 | 公开信息 |

### 2. 数据加密

#### 存储加密
```javascript
// 使用 Web Crypto API 加密
async function encrypt(data, key) {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(JSON.stringify(data));

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const algorithm = { name: 'AES-GCM', iv };

  const encrypted = await crypto.subtle.encrypt(
    algorithm,
    key,
    dataBuffer
  );

  return { iv, encrypted };
}
```

#### 传输加密
- 使用 HTTPS
- 验证证书
- 避免中间人攻击

### 3. 数据脱敏

```javascript
// 手机号脱敏
function maskPhone(phone) {
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
}

// 邮箱脱敏
function maskEmail(email) {
  const [local, domain] = email.split('@');
  const maskedLocal = local.slice(0, 2) + '***';
  return `${maskedLocal}@${domain}`;
}
```

## 安全审计

### 1. 代码审计

#### 审计项
- 权限使用合理性
- 敏感数据处理
- 输入验证完整性
- XSS/CSRF 防护

#### 工具
- ESLint 安全插件
- 依赖漏洞扫描
- 静态代码分析

### 2. 依赖审计

```bash
# 检查依赖漏洞
npm audit

# 更新依赖
npm audit fix
```

### 3. 定期审计

- 每月依赖审计
- 每季度代码审计
- 发布前安全审计

## 安全更新

### 1. 更新策略

- 及时更新依赖
- 关注安全公告
- 快速响应漏洞

### 2. 漏洞处理

#### 漏洞分级
| 级别 | 描述 | 响应时间 |
|------|------|----------|
| 严重 | 可被远程利用 | 24 小时 |
| 高 | 可获取敏感数据 | 72 小时 |
| 中 | 可能影响安全 | 1 周 |
| 低 | 轻微问题 | 1 月 |

#### 处理流程
1. 接收漏洞报告
2. 验证漏洞
3. 评估影响
4. 开发修复
5. 测试验证
6. 发布更新
7. 公告通知

## 安全最佳实践

### 1. 开发阶段

- 使用安全的编码规范
- 进行安全代码审查
- 编写安全测试用例

### 2. 测试阶段

- 安全功能测试
- 渗透测试
- 漏洞扫描

### 3. 发布阶段

- 安全配置检查
- 依赖漏洞检查
- 权限最小化验证

### 4. 运维阶段

- 监控异常行为
- 定期安全审计
- 及时更新修复

## 参考资源

- [Chrome Extension 安全](https://developer.chrome.com/docs/extensions/mv3/security/)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Web Security Guidelines](https://developer.mozilla.org/en-US/docs/Web/Security)

## 更新日志

- [待补充] 初始化安全文档