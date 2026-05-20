# Void macOS ARM 打包流程

本文档用于在 Apple Silicon Mac 上，将 `void` 项目打包为本地可运行的 `.app`，并进一步封装为一个未签名、未公证的 `.dmg` 文件。

适用场景：

- 本机测试
- 内部分发
- 验证 macOS ARM 构建是否正常

不适用场景：

- 面向外部用户正式分发
- 需要 Apple Developer 签名
- 需要 notarization（苹果公证）


## 1. 前置条件

建议先确认以下环境：

- macOS
- Apple Silicon（M1 / M2 / M3 / M4）
- 已安装 Xcode Command Line Tools
- 使用 `zsh`

建议执行：

```bash
xcode-select -p
```

如果没有输出有效路径，可执行：

```bash
xcode-select --install
```


## 2. 检查 nvm 是否正确安装

先确认你机器上的 `nvm` 是真正可用的 `nvm-sh` 版本，而不是误装的 npm 同名包。

执行：

```bash
type nvm
```

正确结果应该包含：

```bash
nvm is a shell function
```

如果不是，说明 `nvm` 没装好，或者装成了错误版本。


## 3. 如果 nvm 未正确安装

官方安装文档：

- [nvm-sh README](https://github.com/nvm-sh/nvm/blob/master/README.md)

可直接执行：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
```

安装完成后：

1. 关闭当前终端
2. 重新打开终端
3. 再次执行：

```bash
type nvm
```


## 4. 进入项目目录

假设项目目录名为 `void`：

```bash
cd /Users/yushaolong/program/void
```


## 5. 切换到项目要求的 Node 版本

本项目要求使用 Node 20。

仓库中的 `.nvmrc` 当前版本为：

```bash
20.18.2
```

执行：

```bash
nvm install 20.18.2
nvm use 20.18.2
node -v
npm -v
```

预期结果：

- `node -v` 输出 `v20.18.2`
- `npm -v` 输出 `10.x`

注意：

- 不要使用 Node 24
- 不要使用 npm 11
- 否则可能在 native 模块编译阶段失败，例如 `tree-sitter` 编译报错


## 6. 安装项目依赖

执行：

```bash
npm install
```

如果你之前用错过 Node 版本，建议先清理后再装：

```bash
rm -rf node_modules build/node_modules remote/node_modules
npm install
```


## 7. 构建 React 产物

Void 的一部分前端代码依赖 `src/vs/workbench/contrib/void/browser/react/out/` 下的构建产物。

如果不先执行这一步，后续 `gulp` 打包通常会报：

- `Cannot find module './react/out/.../index.js'`

执行：

```bash
npm run buildreact
```

成功后，应生成类似目录：

```bash
src/vs/workbench/contrib/void/browser/react/out/
```


## 8. 构建 macOS ARM 应用

执行：

```bash
npm run gulp vscode-darwin-arm64
```

这是仓库里推荐的本地 mac ARM 构建命令。


## 9. 确认 `.app` 产物

构建成功后，产物不在仓库内，而是在 `void/` 的上一级目录：

```bash
../VSCode-darwin-arm64/
```

执行：

```bash
ls ../VSCode-darwin-arm64/*.app
```

如果成功，你会看到类似：

```bash
../VSCode-darwin-arm64/Void.app
```

也可能因为产品名配置不同，显示为别的 `*.app` 名称，但目录结构应一致。


## 10. 本地打开应用验证

建议先确认 `.app` 可正常启动，再封装 `.dmg`。

执行：

```bash
open ../VSCode-darwin-arm64/*.app
```


## 11. 生成本地 `.dmg`

进入项目上一级目录：

```bash
cd ..
```

执行：

```bash
hdiutil create -volname "Void" -srcfolder VSCode-darwin-arm64 -ov -format UDZO Void-darwin-arm64.dmg
```

生成结果：

```bash
Void-darwin-arm64.dmg
```

默认位置：

```bash
/Users/yushaolong/program/Void-darwin-arm64.dmg
```


## 12. 产物说明

此流程生成的 `.dmg` 具有以下特点：

- 已成功封装
- 可用于本机测试
- 可用于内部分发
- 未签名
- 未公证

这意味着：

- 你自己机器通常可以打开
- 发给其他用户时，macOS 可能弹出安全限制提示


## 13. 常见问题

### 13.1 `nvm` 输出：

```bash
This is not the package you are looking for: please go to http://nvm.sh
```

说明你装错了 `nvm`，那是 npm 上的同名占位包，不是真正的 `nvm-sh`。

处理方式：

- 卸掉错误版本
- 按官方 `nvm-sh` 文档重新安装


### 13.2 `npm install` 时 `tree-sitter` 编译失败

常见原因：

- 使用了 Node 24
- 使用了 npm 11

处理方式：

```bash
nvm use 20.18.2
rm -rf node_modules build/node_modules remote/node_modules
npm install
```


### 13.3 `gulp vscode-darwin-arm64` 报错：

```bash
Cannot find module './react/out/.../index.js'
```

说明 React 产物还没生成。

处理方式：

```bash
npm run buildreact
```

然后重新执行：

```bash
npm run gulp vscode-darwin-arm64
```


### 13.4 `.dmg` 能生成，但别人打不开

这是正常现象，因为本地流程生成的是：

- 未签名
- 未公证

如果需要对外分发，需要额外配置：

- Apple Developer 证书
- codesign
- notarization

这不属于当前文档范围。


## 14. 最短执行版

如果你的环境已经正确，最短命令顺序如下：

```bash
cd /Users/yushaolong/program/void
type nvm
nvm install 20.18.2
nvm use 20.18.2
npm install
npm run buildreact
npm run gulp vscode-darwin-arm64
ls ../VSCode-darwin-arm64/*.app
cd ..
hdiutil create -volname "Void" -srcfolder VSCode-darwin-arm64 -ov -format UDZO Void-darwin-arm64.dmg
```


## 15. 结果

最终你会得到两个关键产物：

1. macOS ARM 应用目录

```bash
VSCode-darwin-arm64/
```

2. 本地 `.dmg`

```bash
Void-darwin-arm64.dmg
```
