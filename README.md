# Cursor Unchained

![Cursor Unchained Logo](src/lib/assets/cursor-unchained.png)

This project aims to reverse engineer [Cursor's Tab complete](https://cursor.com/docs/tab/overview) to enable it to be used in other IDEs.

Cursor's Tab complete is known to be the best tab complete on the market, however it's limited to only being available in Cursor which itself is tied down by Vscode's long history of technical debt. Cursor is focused on fixing these problems but why don't we unshackle the beast and bring the best tab complete to all!

Example Tab Completion

![Example Tab Completion](/assets/tabCompletionExample.png)

Example Tab Completion API Response
![Example StreamCpp API Response](/assets/tabCompletionApiResponse.png)

### Scripts

`bun run streamCpp`

![Example Tab Completion](/assets/streamCppExample.png)

`bun run refreshTabContext` [WIP]

(Workspace paths are encoded)

![Example Refresh Tab Context](/assets/refreshTabContextExample.png)

## Requirements

- Cursor Account

## Overview

**StreamCpp**: the main completion service that is used to send tab completion requests to the Cursor API.

**RefreshTabContext**: a context refresh service that is used to refresh the tab context which I believe is used to provide StreamCpp with more context for the tab completion request via codeblocks.

## Zed Cursor Tab Proxy

This fork also includes an experimental Zed bridge:

- Zed patch: https://github.com/nicolasdeory/zed/tree/cursor-tab-external-provider
- Proxy branch: https://github.com/nicolasdeory/cursor-unchained/tree/zed-cursor-tab-proxy

The Zed patch adds an `external` edit-prediction provider. The proxy exposes a local Zed-shaped endpoint and forwards prediction requests to Cursor Tab using the Cursor request format.

### Run The Proxy

```bash
bun install
bun run zed-proxy
```

The proxy listens on:

```text
http://127.0.0.1:17878/predict
```

Health check:

```bash
curl http://127.0.0.1:17878/health
```

### Zed Settings

Use the patched Zed branch and configure edit predictions like this:

```jsonc
{
  "edit_predictions": {
    "provider": "external",
    "external": {
      "api_url": "http://127.0.0.1:17878/predict"
    }
  }
}
```

### Install A macOS Zed Preview App

Clone the patched Zed fork next to this repo, then run the installer:

```bash
git clone https://github.com/nicolasdeory/zed ../zed
git -C ../zed switch cursor-tab-external-provider
bun run install:zed-macos
```

The installer builds the patched Zed release binary, copies the existing Zed Preview app bundle so the normal icon and metadata are preserved, backs up and updates `~/.config/zed/settings.json`, adds the app to the Dock, retargets Apptivate Ctrl-2 when Apptivate is installed, and installs the app as:

```text
/Applications/Zed Preview Cursor Tab.app
```

The app wrapper starts the local proxy on launch if it is not already running, then launches the patched Zed binary. To use a different Zed checkout or app path:

```bash
bun run install:zed-macos -- --zed-repo /path/to/zed --app "/Applications/Zed Cursor Tab.app"
```

To leave Zed settings untouched:

```bash
bun run install:zed-macos -- --no-settings
```

To leave your Dock or Apptivate hotkeys untouched:

```bash
bun run install:zed-macos -- --no-dock --no-apptivate
```

To check for upstream Zed changes, rebase the patched branch, and reinstall when the update succeeds:

```bash
bun run update:zed-macos
```

If a large upstream rebuild is low on disk, retry with regenerable build artifacts cleared:

```bash
bun run update:zed-macos -- --install-arg --clean-build-cache
```

The updater refuses to run when the Zed checkout has local changes or is detached. To preview the update without changing anything:

```bash
bun run update:zed-macos -- --dry-run
```

To check whether the local checkout or installed app is stale without rebasing or rebuilding:

```bash
bun run status:zed-macos
```

To verify the local app, Zed settings, Cursor credentials, proxy health, capture quality gates, and live Cursor-backed probe:

```bash
bun run verify:zed-macos
```

The installer will not overwrite `/Applications/Zed Preview Cursor Tab.app`
while that app is running. If a build succeeds but install is skipped, close Zed
and rerun:

```bash
bun run install:zed-macos -- --no-build
```

If Xcode reports a missing Metal Toolchain during incremental release builds, run:

```bash
xcodebuild -downloadComponent MetalToolchain
xcrun -k
```

On recent Xcode builds, the download may succeed while the default Xcode
toolchain still resolves `metal` to a stub. The macOS installer detects the
downloaded `Metal.xctoolchain`, reads its `ToolchainInfo.plist`, and builds with
`TOOLCHAINS=<Metal toolchain id>` so incremental release builds can use the
downloaded `metal` and `metallib` tools.

### Notes

This is not a full Cursor editor clone. It maps Zed edit-prediction context into Cursor Tab requests, normalizes Cursor's response back into Zed edits, and supports multi-file context when Zed provides it. Cursor account credentials are read from a local `.env`; do not commit that file.

## Setup

1. Follow the below steps to get the environment variables for the StreamCpp/Tab Completion functionality

2. bun install

3. bun run dev

### Environment Variables (StreamCpp)

note: this is obviously a pain and quite brittle, I should find a better way to do this in the future.

1. Create a new file called `.env` in the root of the project. See `env.example` for the required variables.

2. Open Cursor

3. Cmd + Shift + P to open the Command Palette

4. Developer: Open Developer Tools for Extension Host > LocalProcess pid: <pid>

5. Navigate to the Network tab

6. Trigger the tab completion request: in the Network tab this will appear as StreamCpp

7. Copy the bearer token, x-request-id, x-session-id and x-cursor-client-version

8. Copy the values and paste them into the `.env` file

Note: you can run `npx jwt-decode-cli <token>` to decode your CURSOR_BEARER_TOKEN and get the payload with the expiration date (which I estimate to be 1 - 2 months — but could be longer depending on when the token was last refreshed)

## Frontend

1. `bun run dev` to start the development server

2. Open the browser and navigate to `http://localhost:5173`

3. Start typing in the editor and the tab completion will be shown in the transparent editor

4. Press Tab to insert the tab completion into the editor

## Backend

1. `bun run dev` to start the development server

2. Run the following command to send a tab completion request

```bash
curl --location 'http://localhost:5173/api/streamCpp' \
--header 'Content-Type: application/json' \
--data '{
    "code":"function "
}'
```

## Scripts

### StreamCpp

1. `bun run streamCpp` to send a tab completion request

2. The response will be logged to the console

3. Edit payload.currentFile.contents to the code you want to tab complete in the `src/constants.ts` file

### Environment Variables (RefreshTabContext)

This requires looking through and debugging the source code via Help Tab > Toggle Developer Tools.
It's kind of a pain so I'll add it later.

### RefreshTabContext

1. `bun run refreshTabContext` to send a refresh tab context request

2. The response will be logged to the console
