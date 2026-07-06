# 踩坑记录:CJS 扩展动态加载 ESM proxy

> 这份文档记录 cc-switch 合并 llmAutoRetry 后,代理在已安装扩展里起不来的一次踩坑。
> 根因、定位过程、最终解法都在下面。**核心结论先行**,后面是过程。

---

## TL;DR(以后照做就行)

在 VS Code 扩展宿主(CJS 环境)里动态加载一个 ESM 模块时:

```ts
// ❌ 错:用 pathToFileURL 产出 file:// 绝对 URL
const entry = pathToFileURL(path.join(extensionPath, 'proxy', 'server.js')).href;
await import(entry);  // → Cannot find module 'file:///c:/...'

// ✅ 对:用相对路径(不带 scheme)
await import('../proxy/server.js');
```

**只要照抄已验证能跑的 llmAutoRetry 的写法就行**(`extension.cjs:212`):相对路径、无 `file://` scheme。
三平台(Windows / macOS / Linux)一致。别再自己发明路径转换。

---

## 背景

cc-switch 由两个工程合并而来:

- 原 cc-switch:CJS 的 VS Code 扩展(TS 编译到 `out/`,`package.json` 无 `type`,tsc 默认 CJS)。
- 原 llmAutoRetry:扁平结构的 CJS 扩展,`extension.cjs` + `server.js`(ESM)+ 一堆 `.js` 全在根目录平级。**这个单独装能跑。**

合并后,proxy 核心被搬进 `proxy/` 子目录,TS 扩展通过 `proxyHost.ts` 动态 `import()` 加载 `proxy/server.js`。
合并后单独打包安装,**代理起不来**:状态栏没云朵、11434 没监听、控制台访问被拒。

---

## 现象与误判

### 现象(0.1.0)

- 左下角**没有云朵图标**。
- 但活动栏 TreeView 能打开,能配置直连/代理 —— 说明扩展主体活着。
- `http://127.0.0.1:11434/` 拒绝连接。
- 输出面板 `CC Switch + Proxy` 频道**完全空白**。

### 我第一轮的误判(引以为戒)

我猜根因是"`proxyHost.activate()` 里 `statusBar.show()` 排在 `mkdir` 之后,前面挂了就不显示"。
于是改了 0.2.0:`statusBar.show()` 提前 + `import` 移进 try-catch + 加日志。

**这次改对了方向(暴露日志),但没改对根因。** 0.2.0 装上后,日志终于打出来了:

```
动态加载代理模块: file:///~/.vscode/extensions/<publisher>.cc-switch-<version>/proxy/server.js
启动代理失败: Cannot find module 'file:///~/.vscode/extensions/<publisher>.cc-switch-<version>/proxy/server.js'
Require stack:
- ...out\proxyHost.js
- ...out\extension.js
- ...extensionHostProcess.js
  at Module._resolveFilename (node:internal/modules/cjs/loader:1483:15)
```

关键证据:**栈帧是 `cjs/loader._resolveFilename`** —— 这是 **CJS require 的解析路径**,不是 ESM loader。
说明这个 `await import(fileURL字符串)` 被 Electron 扩展宿主拦截,走了 CJS require,把整个 `file://...` URL 当成模块名去 resolve,自然找不到。

### 第二轮:不猜了,对比能跑的 llmAutoRetry

llmAutoRetry 是 source of truth(它单独装能跑)。打开它的 `extension.cjs:212`:

```js
serverModule = await import('./server.js');   // 相对路径,无 scheme
```

就这么一行。区别立刻清晰:

| 维度 | llmAutoRetry(能跑) | cc-switch 0.2.0(挂) |
|---|---|---|
| import 参数 | `'./server.js'` 相对路径 | `pathToFileURL(...).href` → `file:///c:/...` |
| 是否带 scheme | 否 | 是(`file://`) |
| 走的加载器 | Node ESM loader(按 package.json `type:module`) | Electron CJS require 拦截 |
| 结果 | 成功 | `Cannot find module 'file://...'` |

**根因:`pathToFileURL` 产出的 `file://` URL 触发了扩展宿主的 CJS require 拦截。** 用相对路径就不带 scheme,绕开拦截,走真 ESM loader。

> 为什么我自己测时 `node test-esm.mjs` 用 fileURL 能成功?因为那是**原生 node**,没有 Electron 的 require 拦截。扩展宿主是 Electron,行为不同。**不能用原生 node 的结果推断扩展宿主行为。**

---

## 最终解法(0.2.1,已验证)

[proxyHost.ts](src/proxyHost.ts) `tryBecomeHost()`:

```ts
// 加载方式照搬 llmAutoRetry(已验证能在扩展宿主跑):相对路径,不带 file:// scheme。
// out/proxyHost.js 到 proxy/server.js 是 ../proxy/server.js。
this.proxyModule = await import('../proxy/server.js') as ProxyModule;
```

注意点:

1. **相对路径基于当前模块文件解析**。`out/proxyHost.js` → `proxy/server.js` 是 `../proxy/server.js`,不是 `./proxy/server.js`(那会找 `out/proxy/server.js`)。
2. **tsc 会报 TS7016**(找不到 `.d.ts`)。压一行:`// @ts-expect-error server.js 是 ESM、无 .d.ts;运行时由 Node 解析,类型此处无意义。`
3. **`proxy/package.json` 必须有 `{"type":"module"}`**,否则 `.js` 会被当 CJS,`import` 里的 `export` 语法报错。这个文件 `.vscodeignore` 没排除,会打进 vsix。

---

## 调试方法论(这次值得记的)

1. **`void promiseFn()` 会吞异常。** `extension.ts` 里 `void proxyHost?.activate();` 把 `activate()` 的异常静默吞掉,导致零日志零诊断。任何被 `void` 调用的 async 函数,内部必须自己 try-catch 并落日志。
2. **状态栏/可见 UI 要尽量早地 show。** 别排在可能抛错的步骤(mkdir、写文件、import)之后,否则前一步挂了,用户连"扩展活着"都看不到,无从诊断。这次把 `statusBar.show()` 提到 `activate()` 第一行,是 0.2.0 能暴露日志的前提。
3. **有 source of truth 就别猜。** llmAutoRetry 单独装能跑,直接 diff 它怎么加载 server.js,比从栈帧反推 Electron 内部行为快十倍。我第一轮绕了大弯,第二轮一对比就定位了。
4. **别用原生 node 验证扩展宿主行为。** Electron 扩展宿主对模块加载有拦截,和原生 node 不一样。要测就测真实安装的扩展(`~/.vscode/extensions/<id>/`),或开 Extension Development Host。
5. **栈帧会说话。** `cjs/loader._resolveFilename` 直接说明走的是 CJS require,不是 ESM loader。看栈帧比看报错消息更准。

---

## 验证清单(每次改完加载逻辑都过一遍)

安装新 vsix + Reload Window 后:

- [ ] 左下角云朵图标出现,显示"代理:本窗口运行"
- [ ] 输出面板 `CC Switch + Proxy` 有 `动态加载代理模块: ../proxy/server.js` + `成为宿主,代理在 127.0.0.1:11434 运行`
- [ ] `http://127.0.0.1:11434/` 控制台能打开
- [ ] `netstat -ano | findstr 11434` 有监听行
- [ ] 多窗口:A 窗口"本窗口运行",B 窗口"其他窗口运行";关 A 后 B 在 2s 内接管

---

## 相关文件

- [src/proxyHost.ts](src/proxyHost.ts) — `tryBecomeHost()` 的 import 写法
- [proxy/package.json](proxy/package.json) — `{"type":"module"}` 让 server.js 当 ESM
- [.vscodeignore](.vscodeignore) — 确认 proxy/ 不被排除(只排 `proxy/logs/**`)
- 对比基准:llmAutoRetry 工程的 `extension.cjs:212`
