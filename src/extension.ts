import * as path from 'node:path';
import * as vscode from 'vscode';
import { DaemonStatus, OfsyncClient } from './ofsync-client';
import { createPdfPreviewHtml } from './pdf-preview';

const LATEX_EXTENSIONS = new Set(['.tex', '.ltx', '.latex']);

interface SyncCodeResult {
  page?: number;
  h?: number;
  v?: number;
  x?: number;
  y?: number;
  buildId?: string;
  [key: string]: unknown;
}

interface SyncPdfResult {
  file?: string;
  line?: number;
  column?: number;
  path?: string;
  [key: string]: unknown;
}

export function activate(context: vscode.ExtensionContext): void {
  const controller = new OfsyncController(context);
  context.subscriptions.push(controller);
  context.subscriptions.push(
    vscode.commands.registerCommand('ofsync.compile', () => controller.compile()),
    vscode.commands.registerCommand('ofsync.sync', () => controller.sync()),
    vscode.commands.registerCommand('ofsync.showPdfLocation', () => controller.showPdfLocation()),
    vscode.commands.registerCommand('ofsync.openSourceLocation', () => controller.openSourceLocation()),
    vscode.commands.registerCommand('ofsync.openPdfPreview', () => controller.openPdfPreview()),
    vscode.commands.registerCommand('ofsync.showStatus', () => controller.showStatus()),
    vscode.window.registerWebviewViewProvider('ofsync.controlPanel', controller),
  );
}

export function deactivate(): void {}

class OfsyncController implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private poller: NodeJS.Timeout | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private view: vscode.WebviewView | undefined;
  private connected = false;
  private status: DaemonStatus | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem.name = 'Ofsync connection';
    this.statusItem.command = 'ofsync.showStatus';
    this.statusItem.show();
    this.startPolling();
  }

  public dispose(): void {
    if (this.poller) {
      clearInterval(this.poller);
    }
    this.statusItem.dispose();
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.controlPanelHtml(view.webview);
    view.webview.onDidReceiveMessage((message: { type?: string }) => {
      switch (message.type) {
        case 'compile': return this.compile();
        case 'sync': return this.sync();
        case 'openPdf': return this.openPdfPreview();
        case 'showPdfLocation': return this.showPdfLocation();
        case 'openSourceLocation': return this.openSourceLocation();
        case 'refresh': return this.poll();
        default: return undefined;
      }
    }, undefined, this.context.subscriptions);
    this.publishState();
  }

  public async compile(): Promise<void> {
    await this.runOperation('Compiling remote project…', async () => {
      const result = await this.client().compile();
      this.updateBuildId(result);
      await this.poll();
      this.openPdfPreview(true);
    });
  }

  public async sync(): Promise<void> {
    await this.runOperation('Synchronizing project…', async () => {
      await this.client().sync();
      await this.poll();
    });
  }

  public async showPdfLocation(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('Open a LaTeX source file before requesting a PDF location.');
      return;
    }
    if (!LATEX_EXTENSIONS.has(path.extname(editor.document.uri.fsPath).toLowerCase())) {
      void vscode.window.showWarningMessage('The active file is not a LaTeX source file.');
      return;
    }

    const buildId = this.buildId();
    if (!buildId) {
      void vscode.window.showWarningMessage('Compile the remote project successfully before using SyncTeX.');
      return;
    }
    const root = this.projectRoot();
    const relativePath = path.relative(root, editor.document.uri.fsPath).split(path.sep).join('/');
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      void vscode.window.showErrorMessage('The active file is outside the configured Ofsync project root.');
      return;
    }

    await this.runOperation('Looking up PDF location…', async () => {
      const selection = editor.selection.active;
      const result = await this.client().syncCode(relativePath, selection.line + 1, selection.character + 1, buildId) as SyncCodeResult;
      this.openPdfPreview(false, result);
      void vscode.window.showInformationMessage('Opened the compiled PDF for the current source location.');
    });
  }

  public async openSourceLocation(): Promise<void> {
    const buildId = this.buildId();
    if (!buildId) {
      void vscode.window.showWarningMessage('Compile the remote project successfully before using SyncTeX.');
      return;
    }
    const page = await vscode.window.showInputBox({ prompt: 'PDF page number', placeHolder: '1', validateInput: positiveInteger });
    if (!page) {
      return;
    }
    const horizontal = await vscode.window.showInputBox({ prompt: 'Horizontal PDF coordinate (h)', placeHolder: '0', value: '0', validateInput: finiteNumber });
    if (horizontal === undefined) {
      return;
    }
    const vertical = await vscode.window.showInputBox({ prompt: 'Vertical PDF coordinate (v)', placeHolder: '0', value: '0', validateInput: finiteNumber });
    if (vertical === undefined) {
      return;
    }

    await this.runOperation('Looking up source location…', async () => {
      const result = await this.client().syncPdf(Number(page), Number(horizontal), Number(vertical), buildId) as SyncPdfResult;
      await this.revealSource(result);
    });
  }

  public openPdfPreview(refresh = false, location?: SyncCodeResult): void {
    const panel = this.panel ?? vscode.window.createWebviewPanel(
      'ofsync.pdfPreview',
      'Ofsync PDF Preview',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel = panel;
    panel.onDidDispose(() => { this.panel = undefined; }, undefined, this.context.subscriptions);
    panel.webview.onDidReceiveMessage((message: { type?: string; page?: number; h?: number; v?: number }) => {
      if (message.type === 'openSource' && message.page !== undefined && message.h !== undefined && message.v !== undefined) {
        void this.openSourceFromCoordinates(message.page, message.h, message.v);
      }
      if (message.type === 'previewReady' || message.type === 'reloadPdf') {
        void this.loadPdf(panel);
      }
    }, undefined, this.context.subscriptions);
    panel.webview.html = this.pdfHtml(panel.webview, refresh, location);
    panel.reveal(vscode.ViewColumn.Beside, true);
  }

  public showStatus(): void {
    const summary = this.connected
      ? `Connected to ${this.serverUrl()}\nPhase: ${this.status?.phase ?? 'unknown'}\nProject: ${this.status?.project?.projectName ?? 'unknown'}\nPending: ${this.status?.pendingPaths?.length ?? 0}\nConflicts: ${this.status?.conflicts?.length ?? 0}`
      : `Disconnected from ${this.serverUrl()}`;
    void vscode.window.showInformationMessage(summary, 'Open PDF Preview', 'Refresh').then((choice) => {
      if (choice === 'Open PDF Preview') {
        this.openPdfPreview();
      } else if (choice === 'Refresh') {
        void this.poll();
      }
    });
  }

  private startPolling(): void {
    void this.poll();
    const interval = Math.max(1000, vscode.workspace.getConfiguration('ofsync').get<number>('statusPollInterval', 3000));
    this.poller = setInterval(() => void this.poll(), interval);
  }

  private async poll(): Promise<void> {
    try {
      const client = this.client();
      await client.health();
      this.status = await client.status();
      this.connected = true;
    } catch {
      this.connected = false;
      this.status = undefined;
    }
    this.updateStatusItem();
    this.publishState();
  }

  private updateStatusItem(): void {
    if (!this.connected) {
      this.statusItem.text = '$(debug-disconnect) Ofsync: offline';
      this.statusItem.tooltip = `Cannot reach ${this.serverUrl()}`;
      this.statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      return;
    }
    const pending = this.status?.pendingPaths?.length ?? 0;
    const conflicts = this.status?.conflicts?.length ?? 0;
    const phase = this.status?.phase ?? 'ready';
    this.statusItem.text = `$(cloud) Ofsync: ${phase}${pending ? ` · ${pending} pending` : ''}${conflicts ? ` · ${conflicts} conflicts` : ''}`;
    this.statusItem.tooltip = `${this.status?.project?.projectName ?? 'Ofsync daemon'}\n${this.serverUrl()}`;
    this.statusItem.backgroundColor = conflicts ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  private async runOperation(label: string, operation: () => Promise<void>): Promise<void> {
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Ofsync: ${label}` }, operation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Ofsync: ${message}`);
    } finally {
      await this.poll();
    }
  }

  private async openSourceFromCoordinates(page: number, h: number, v: number): Promise<void> {
    const buildId = this.buildId();
    if (!buildId) {
      void vscode.window.showWarningMessage('Set “Ofsync: Build Id” before opening a source location.');
      return;
    }
    await this.runOperation('Looking up source location…', async () => {
      const result = await this.client().syncPdf(page, h, v, buildId) as SyncPdfResult;
      await this.revealSource(result);
    });
  }

  private async loadPdf(panel: vscode.WebviewPanel): Promise<void> {
    try {
      const bytes = await this.client().pdf();
      await panel.webview.postMessage({ type: 'pdfData', bytes });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await panel.webview.postMessage({ type: 'pdfError', message: `Unable to load compiled PDF: ${message}` });
    }
  }

  private async revealSource(result: SyncPdfResult): Promise<void> {
    const reportedPath = result.file ?? result.path;
    const line = numberValue(result.line) ?? 1;
    const column = numberValue(result.column) ?? 1;
    if (!reportedPath) {
      throw new Error('The daemon did not return a source file location.');
    }
    const root = this.projectRoot();
    const candidate = path.resolve(root, reportedPath);
    if (!isChildPath(root, candidate)) {
      throw new Error('The daemon returned a source path outside the configured project root.');
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(candidate));
    const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
    const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  private client(): OfsyncClient {
    return new OfsyncClient(this.serverUrl());
  }

  private serverUrl(): string {
    return vscode.workspace.getConfiguration('ofsync').get<string>('serverUrl', 'http://127.0.0.1:43821').replace(/\/$/, '');
  }

  private projectRoot(): string {
    const configured = vscode.workspace.getConfiguration('ofsync').get<string>('projectRoot', '').trim();
    if (configured) {
      return path.resolve(configured);
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      throw new Error('Open the local LaTeX project folder or configure “Ofsync: Project Root”.');
    }
    return workspaceFolder.uri.fsPath;
  }

  private buildId(): string {
    return this.status?.latestCompile?.buildId?.trim()
      || vscode.workspace.getConfiguration('ofsync').get<string>('buildId', '').trim();
  }

  private updateBuildId(value: unknown): void {
    if (typeof value !== 'object' || value === null || !('buildId' in value)) {
      return;
    }
    const buildId = (value as { buildId?: unknown }).buildId;
    if (typeof buildId === 'string' && buildId.length > 0) {
      void vscode.workspace.getConfiguration('ofsync').update('buildId', buildId, vscode.ConfigurationTarget.Workspace);
    }
  }

  private publishState(): void {
    const message = {
      type: 'state',
      connected: this.connected,
      status: this.status,
      serverUrl: this.serverUrl(),
      buildId: this.buildId(),
    };
    void this.view?.webview.postMessage(message);
  }

  private controlPanelHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}.row{display:flex;gap:8px;flex-wrap:wrap}button{border:0;padding:6px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}#status{white-space:pre-wrap;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family);font-size:12px}.online{color:var(--vscode-testing-iconPassed)}.offline{color:var(--vscode-testing-iconFailed)}</style></head><body><h3>Ofsync</h3><p id="connection">Checking daemon…</p><div class="row"><button data-action="sync">Sync</button><button data-action="compile">Compile</button><button data-action="openPdf">PDF Preview</button></div><p></p><div class="row"><button data-action="showPdfLocation">Source → PDF</button><button data-action="openSourceLocation">PDF → Source</button></div><h4>Status</h4><div id="status">Waiting for daemon status…</div><script nonce="${nonce}">const vscode=acquireVsCodeApi();const connection=document.getElementById('connection');const status=document.getElementById('status');document.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action})));window.addEventListener('message',event=>{const data=event.data;if(data.type!=='state')return;connection.textContent=data.connected?'● Connected: '+data.serverUrl:'● Disconnected: '+data.serverUrl;connection.className=data.connected?'online':'offline';const s=data.status;if(!s){status.textContent='The local ofsync daemon is unavailable.';return;}status.textContent=['Project: '+(s.project?.projectName??'unknown'),'Phase: '+(s.phase??'unknown'),'Pending files: '+(s.pendingPaths?.length??0),'Conflicts: '+(s.conflicts?.length??0),'Build ID: '+(data.buildId||'not configured'),s.lastError?'Last error: '+s.lastError:''].filter(Boolean).join('\\n');});</script></body></html>`;
  }

  private legacyPdfHtml(webview: vscode.Webview, refresh: boolean, location?: SyncCodeResult): string {
    const nonce = createNonce();
    const pdfUrl = this.client().pdfUrl(refresh);
    const page = numberValue(location?.page);
    const h = numberValue(location?.h) ?? numberValue(location?.x);
    const v = numberValue(location?.v) ?? numberValue(location?.y);
    const locationLabel = page !== undefined ? `Source mapping result: page ${page}${h !== undefined && v !== undefined ? `, coordinates ${h}, ${v}` : ''}.` : 'Use the PDF controls below to look up a source location.';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${webview.cspSource} http: https:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);height:100vh;display:grid;grid-template-rows:auto 1fr}.toolbar{padding:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border)}input{width:5em;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px}button{border:0;padding:6px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}iframe{border:0;width:100%;height:100%;background:#fff}.hint{color:var(--vscode-descriptionForeground);font-size:12px}</style></head><body><div class="toolbar"><button id="reload">Reload PDF</button><label>Page <input id="page" type="number" min="1" value="${page ?? 1}"></label><label>h <input id="h" type="number" value="${h ?? 0}"></label><label>v <input id="v" type="number" value="${v ?? 0}"></label><button id="openSource">Open source at coordinates</button><span class="hint">${locationLabel}</span></div><iframe id="pdf" src="${pdfUrl}" title="Compiled PDF"></iframe><script nonce="${nonce}">const vscode=acquireVsCodeApi();const pdf=document.getElementById('pdf');document.getElementById('reload').onclick=()=>pdf.src=${JSON.stringify(this.client().pdfUrl(true))};document.getElementById('openSource').onclick=()=>{const page=Number(document.getElementById('page').value),h=Number(document.getElementById('h').value),v=Number(document.getElementById('v').value);if(Number.isFinite(page)&&Number.isFinite(h)&&Number.isFinite(v))vscode.postMessage({type:'openSource',page,h,v});};</script></body></html>`;
  }

  private pdfHtml(webview: vscode.Webview, _refresh: boolean, location?: SyncCodeResult): string {
    return createPdfPreviewHtml(webview, this.context.extensionUri, location);
  }
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function positiveInteger(value: string): string | undefined {
  return /^\d+$/.test(value) && Number(value) > 0 ? undefined : 'Enter a positive integer.';
}

function finiteNumber(value: string): string | undefined {
  return Number.isFinite(Number(value)) ? undefined : 'Enter a number.';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isChildPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
