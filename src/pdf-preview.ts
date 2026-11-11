import * as vscode from 'vscode';

interface SyncCodeLocation {
  page?: number;
  h?: number;
  v?: number;
  x?: number;
  y?: number;
}

export function createPdfPreviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, location?: SyncCodeLocation): string {
  const nonce = createNonce();
  const pdfJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs', 'pdf.mjs'));
  const pdfWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs', 'pdf.worker.mjs'));
  const page = positiveNumber(location?.page) ?? 1;
  const locationLabel = location?.page ? `Source mapping result: page ${page}.` : 'Double-click PDF content to open its corresponding LaTeX source.';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src ${webview.cspSource};"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);height:100vh;display:grid;grid-template-rows:auto 1fr}.toolbar{padding:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border)}button{border:0;padding:6px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}.hint{color:var(--vscode-descriptionForeground);font-size:12px}#viewer{overflow:auto;padding:22px;background:var(--vscode-editor-background)}.page{position:relative;margin:0 auto 20px;width:max-content;box-shadow:0 1px 8px #0008;background:#fff;line-height:0;cursor:crosshair}canvas{display:block;max-width:100%;height:auto}#message{padding:20px;color:var(--vscode-descriptionForeground)}</style></head><body><div class="toolbar"><button id="reload">Reload PDF</button><span class="hint">${locationLabel}</span></div><main id="viewer"><div id="message">Loading compiled PDF…</div></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();const viewer=document.getElementById('viewer');const message=document.getElementById('message');const targetPage=${page};const pdfJsUri=${JSON.stringify(pdfJsUri.toString())};const pdfWorkerUri=${JSON.stringify(pdfWorkerUri.toString())};let pdfjs;document.getElementById('reload').addEventListener('click',()=>{message.textContent='Reloading compiled PDF…';viewer.replaceChildren(message);vscode.postMessage({type:'reloadPdf'})});async function renderPdf(bytes){try{pdfjs??=await import(pdfJsUri);pdfjs.GlobalWorkerOptions.workerSrc=pdfWorkerUri;const pdf=await pdfjs.getDocument({data:bytes}).promise;viewer.replaceChildren();for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber+=1){const pdfPage=await pdf.getPage(pageNumber);const viewport=pdfPage.getViewport({scale:1.5});const canvas=document.createElement('canvas');const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('Could not create PDF rendering context.');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);const pageElement=document.createElement('section');pageElement.className='page';pageElement.dataset.pageNumber=String(pageNumber);pageElement.append(canvas);pageElement.addEventListener('dblclick',event=>{const bounds=canvas.getBoundingClientRect();const scaleX=canvas.width/bounds.width;const scaleY=canvas.height/bounds.height;const point=viewport.convertToPdfPoint((event.clientX-bounds.left)*scaleX,(event.clientY-bounds.top)*scaleY);vscode.postMessage({type:'openSource',page:pageNumber,h:point[0],v:viewport.viewBox[3]-point[1]})});viewer.append(pageElement);await pdfPage.render({canvasContext:context,viewport}).promise}document.querySelector('[data-page-number="'+targetPage+'"]')?.scrollIntoView({block:'center'})}catch(error){viewer.replaceChildren(message);message.textContent='Unable to render the compiled PDF: '+(error instanceof Error?error.message:String(error))}}window.addEventListener('message',event=>{const data=event.data;if(data.type==='pdfData')renderPdf(new Uint8Array(data.bytes));if(data.type==='pdfError'){viewer.replaceChildren(message);message.textContent=data.message}});vscode.postMessage({type:'previewReady'});</script></body></html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
