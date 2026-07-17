import * as vscode from 'vscode';
import type { LLMConfig } from './types';
import { ConfigStore, newId } from './configStore';
import { detectPlatform, readSettings } from './claudeConfig';

interface EditorHandlers {
    onSaved: () => void;
    switchConfig: (cfg: LLMConfig) => Promise<void>;
}

/**
 * Webview panel for creating/editing a single LLM config (name + a textarea
 * holding the full settings.json content). New configs are pre-filled with the
 * current settings.json so the user doesn't start from a blank page.
 */
export class WebviewEditor {
    /** Track open panels by config id (or 'new') to avoid duplicates. */
    private readonly panels = new Map<string, vscode.WebviewPanel>();

    constructor(
        private readonly store: ConfigStore,
        private readonly handlers: EditorHandlers,
    ) {}

    async openNew(): Promise<void> {
        const live = await readSettings(detectPlatform().configPath);
        const content = live ?? TEMPLATE;
        await this.open('new', undefined, 'New LLM Config', '', content, 'direct');
    }

    async openEdit(cfg: LLMConfig): Promise<void> {
        await this.open(cfg.id, cfg.id, `Edit: ${cfg.name}`, cfg.name, cfg.content, cfg.mode === 'proxy' ? 'proxy' : 'direct');
    }

    private async open(
        key: string,
        existingId: string | undefined,
        title: string,
        name: string,
        content: string,
        mode: 'direct' | 'proxy',
    ): Promise<void> {
        const existing = this.panels.get(key);
        if (existing) {
            existing.reveal(vscode.ViewColumn.Active, false);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'claude-code-proxy.editor',
            title,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
            },
        );
        panel.webview.html = this.buildHtml(title, name, content, mode);

        panel.webview.onDidReceiveMessage(
            (msg: WebviewMessage) => this.onMessage(panel, key, existingId, msg),
            undefined,
            [],
        );

        panel.onDidDispose(() => this.panels.delete(key));
        this.panels.set(key, panel);
    }

    private async onMessage(
        panel: vscode.WebviewPanel,
        key: string,
        existingId: string | undefined,
        msg: WebviewMessage,
    ): Promise<void> {
        if (msg.type === 'cancel') {
            panel.dispose();
            return;
        }

        if (msg.type !== 'save' && msg.type !== 'saveAndSwitch') {
            return;
        }

        const name = msg.name.trim();
        const content = msg.content.trim();

        if (!name) {
            panel.webview.postMessage({ type: 'error', message: 'Name is required.' });
            return;
        }
        try {
            JSON.parse(content); // validate JSON before persisting
        } catch (e) {
            panel.webview.postMessage({ type: 'error', message: `Invalid JSON: ${(e as Error).message}` });
            return;
        }

        const cfg: LLMConfig = {
            id: existingId ?? newId(),
            name,
            content,
            mode: msg.mode === 'proxy' ? 'proxy' : 'direct',
            updatedAt: new Date().toISOString(),
        };
        await this.store.upsert(cfg);
        this.handlers.onSaved();

        panel.webview.postMessage({ type: 'saved' });

        if (msg.type === 'saveAndSwitch') {
            await this.handlers.switchConfig(cfg);
        }
        panel.dispose();
    }

    private buildHtml(title: string, name: string, content: string, mode: 'direct' | 'proxy'): string {
        const nonce = getNonce();
        const escapedName = escapeHtml(name);
        const escapedContent = escapeHtml(content);
        const directChecked = mode === 'direct' ? 'checked' : '';
        const proxyChecked = mode === 'proxy' ? 'checked' : '';
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 20px;
    box-sizing: border-box;
  }
  label { display: block; margin: 0 0 6px; font-weight: 600; }
  .row { margin-bottom: 16px; }
  input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    color: var(--vscode-input-foreground);
    border-radius: 2px;
    font-size: 13px;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    min-height: 380px;
    resize: vertical;
    padding: 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    color: var(--vscode-input-foreground);
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.4;
    white-space: pre;
    overflow-wrap: normal;
    overflow: auto;
  }
  #error {
    margin: 8px 0;
    min-height: 18px;
    color: var(--vscode-errorForeground, #f48771);
    font-size: 12px;
    white-space: pre-wrap;
  }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
  .actions { margin-top: 12px; display: flex; gap: 8px; }
  button {
    padding: 6px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
</style>
</head>
<body>
  <div class="row">
    <label for="name">Name</label>
    <input type="text" id="name" value="${escapedName}" placeholder="e.g. glm-5.2 (Volc)" />
  </div>
  <div class="row">
    <label>连接模式</label>
    <label style="font-weight:normal; margin-bottom:4px"><input type="radio" name="mode" value="direct" ${directChecked} /> 直连 — Claude Code 直接连此上游（默认）</label>
    <label style="font-weight:normal; margin-bottom:0"><input type="radio" name="mode" value="proxy" ${proxyChecked} /> 通过代理连接 — 代理用此上游重试 503，Claude Code 经代理连接</label>
  </div>
  <div class="row">
    <label for="content">settings.json content</label>
    <textarea id="content" spellcheck="false">${escapedContent}</textarea>
    <div class="hint">This is the full content written to Claude Code's settings.json when you switch (direct), or used as the proxy's upstream (proxy mode).</div>
  </div>
  <div id="error" aria-live="polite"></div>
  <div class="actions">
    <button id="save" type="button">Save</button>
    <button id="saveSwitch" type="button">Save &amp; Switch</button>
    <button id="cancel" class="secondary" type="button">Cancel</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const nameEl = document.getElementById('name');
    const contentEl = document.getElementById('content');
    const errorEl = document.getElementById('error');
    const saveBtn = document.getElementById('save');
    const saveSwitchBtn = document.getElementById('saveSwitch');

    function validate() {
      const text = contentEl.value.trim();
      let ok = nameEl.value.trim().length > 0 && text.length > 0;
      if (ok) {
        try { JSON.parse(text); errorEl.textContent = ''; }
        catch (e) { ok = false; errorEl.textContent = 'Invalid JSON: ' + e.message; }
      } else {
        errorEl.textContent = '';
      }
      saveBtn.disabled = !ok;
      saveSwitchBtn.disabled = !ok;
    }

    nameEl.addEventListener('input', validate);
    contentEl.addEventListener('input', validate);

    function selectedMode() {
      const checked = document.querySelector('input[name="mode"]:checked');
      return checked ? checked.value : 'direct';
    }

    saveBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'save', name: nameEl.value, content: contentEl.value, mode: selectedMode() });
    });
    saveSwitchBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'saveAndSwitch', name: nameEl.value, content: contentEl.value, mode: selectedMode() });
    });
    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'error') { errorEl.textContent = msg.message; }
      else if (msg.type === 'saved') { /* host will close panel */ }
    });

    validate();
    nameEl.focus();
  </script>
</body>
</html>`;
    }
}

type WebviewMessage =
    | { type: 'save' | 'saveAndSwitch'; name: string; content: string; mode: 'direct' | 'proxy' }
    | { type: 'cancel' };

const TEMPLATE = `{
  "env": {
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_MODEL": ""
  }
}`;

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getNonce(): string {
    let nonce = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        nonce += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return nonce;
}
