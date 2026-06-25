# Welcome to Void.

<div align="center">
	<img
		src="./src/vs/workbench/browser/parts/editor/media/slice_of_void.png"
	 	alt="Void Welcome"
		width="300"
	 	height="300"
	/>
</div>

Void is the open-source Cursor alternative.

Use AI agents on your codebase, checkpoint and visualize changes, and bring any model or host locally. Void sends messages directly to providers without retaining your data.

This repo contains the full sourcecode for Void. If you're new, welcome!

- 🧭 [Website](https://voideditor.com)

- 👋 [Discord](https://discord.gg/RSNjgaugJs)

- 🚙 [Project Board](https://github.com/orgs/voideditor/projects/2)


## Note

We've paused work on the Void IDE (this repo) to explore a few novel coding ideas. We want to focus on innovation over feature-parity. Void will continue running, but without maintenance some existing features might stop working over time. Depending on the direction of our new work, we might not resume Void as an IDE.

We won't be actively reviewing Issues and PRs, but we will respond to all [email](mailto:hello@voideditor.com) inquiries on building and maintaining your own version of Void while we're paused.

## Reference

Void is a fork of the [vscode](https://github.com/microsoft/vscode) repository. For a guide to the codebase, see [VOID_CODEBASE_GUIDE](https://github.com/voideditor/void/blob/main/VOID_CODEBASE_GUIDE.md).

For a guide on how to develop your own version of Void, see [HOW_TO_CONTRIBUTE](https://github.com/voideditor/void/blob/main/HOW_TO_CONTRIBUTE.md) and [void-builder](https://github.com/voideditor/void-builder).

For a local macOS ARM packaging guide, see [MacPack](./MacPack.md).

### Opts

- Agent checkpoint resume: recover malformed XML tool calls such as incomplete `read_file` outputs.
- Agent checkpoint resume: continue tool execution when XML tool calls are emitted inside reasoning content.
- `edit_file` matching: tolerate whitespace and comment differences when locating `ORIGINAL` blocks.
- macOS ARM packaging: see [MacPack](./MacPack.md).
- agent capability enhance like claude-code: see [ENHENCE-LIKE-CLAUDE](./enhance-like-claude.md).
- try to build your own custom agent: see [BUILD-CUSTOM-AGENT](./build-custom-agent.md).



## Development

You can run the development build like this:

```shell
npm run watch
```

Open another terminal:

```shell
./scripts/code.sh
```

If you just want to quickly launch and see it, you can also try:

```shell
./scripts/code.sh
```

But it's recommended to run `npm run watch` first, as this is the standard development workflow for a VSCode/Void fork — changes are continuously compiled.

### Installing Python Extensions

Extensions to install:
- Python
- Python Debugger
- Black Formatter

> **Note**: Do not install Pylance — it causes recognition conflicts. Installing the Python extension may automatically install Pylance; if that happens, uninstall Pylance separately.

Press `command+shift+P` and open `Open User Settings (JSON)`, then set the following:

```json
{
    "editor.fontSize": 13,
    "python.languageServer": "None",
    "workbench.editor.empty.hint": "hidden",
    "explorer.confirmDelete": false,
    "window.openFoldersInNewWindow": "on",
    "explorer.confirmDragAndDrop": false,
    "python.autoComplete.extraPaths": [],
    "editor.defaultFormatter": "ms-python.black-formatter",
    "editor.formatOnSave": true,
    "files.autoSave": "afterDelay",
    "extensions.ignoreRecommendations": true,
    "window.autoDetectColorScheme": false
}
```



## Support
You can always reach us in our Discord server or contact us via email: hello@voideditor.com.


