import * as vscode from 'vscode';

interface SyncCodeLocation {
  page?: number;
  h?: number;
  v?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  sourceText?: string;
}

export function createPdfPreviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, location?: SyncCodeLocation): string {
  const nonce = createNonce();
  const pdfJsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs', 'pdf.mjs'));
  const pdfWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs', 'pdf.worker.mjs'));
  const targetPage = positiveNumber(location?.page) ?? 1;
  const targetH = finiteNumber(location?.h) ?? finiteNumber(location?.x);
  const targetV = finiteNumber(location?.v) ?? finiteNumber(location?.y);
  const targetWidth = finiteNumber(location?.width);
  const targetHeight = finiteNumber(location?.height);
  const hint = location?.page
    ? 'Jumped from source. Double-click PDF text to return to LaTeX.'
    : 'Double-click PDF text to open its corresponding LaTeX source.';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);height:100vh;display:grid;grid-template-rows:auto 1fr}
    .toolbar{padding:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border)}
    button{border:0;padding:6px 8px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}
    button:hover{background:var(--vscode-button-hoverBackground)}
    .hint{color:var(--vscode-descriptionForeground);font-size:12px}
    #viewer{overflow:auto;padding:22px;background:var(--vscode-editor-background)}
    .page{position:relative;margin:0 auto 20px;width:max-content;box-shadow:0 1px 8px #0008;background:#fff;line-height:0;cursor:crosshair}
    canvas{display:block}
    .text-layer{position:absolute;inset:0;overflow:hidden;line-height:1;text-size-adjust:none;transform-origin:0 0}
    .text-item{position:absolute;display:block;white-space:pre;transform-origin:0 0;color:transparent;cursor:text;line-height:1}
    .text-item::selection{background:#4c9ffe66}
    .text-item.sync-text-highlight{color:#111;background:#ffe45c;border-radius:2px;box-shadow:0 0 0 3px #ffe45c88,0 0 18px 6px #ffe45ccc;animation:sync-text-highlight 1s ease-in-out 3}
    .sync-highlight{position:absolute;width:150px;height:32px;transform:translate(-50%,-50%);border:3px solid #ffcc00;border-radius:6px;background:#ffcc0038;box-shadow:0 0 0 4px #ffcc0040,0 0 22px 8px #ffcc00cc;pointer-events:none;z-index:4;animation:sync-highlight 1s ease-in-out 3}
    @keyframes sync-highlight{0%,100%{opacity:.08;box-shadow:0 0 0 2px #ffcc0018,0 0 8px 2px #ffcc0055}50%{opacity:1;box-shadow:0 0 0 6px #ffcc0077,0 0 30px 12px #ffcc00ee}}
    @keyframes sync-text-highlight{0%,100%{background:#ffe45c22;box-shadow:0 0 0 1px #ffe45c22}50%{background:#ffe45c;box-shadow:0 0 0 4px #ffe45c99,0 0 18px 6px #ffe45ccc}}
    #message{padding:20px;color:var(--vscode-descriptionForeground)}
  </style>
</head>
<body>
  <div class="toolbar"><button id="reload">Reload PDF</button><span class="hint">${hint}</span></div>
  <main id="viewer"><div id="message">Loading compiled PDF…</div></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const viewer = document.getElementById('viewer');
    const message = document.getElementById('message');
    const target = { page: ${targetPage}, h: ${targetH ?? 'undefined'}, v: ${targetV ?? 'undefined'}, width: ${targetWidth ?? 'undefined'}, height: ${targetHeight ?? 'undefined'}, sourceText: ${JSON.stringify(location?.sourceText ?? '')} };
    const pdfJsUri = ${JSON.stringify(pdfJsUri.toString())};
    const pdfWorkerUri = ${JSON.stringify(pdfWorkerUri.toString())};
    let pdfjs;

    document.getElementById('reload').addEventListener('click', () => {
      message.textContent = 'Reloading compiled PDF…';
      viewer.replaceChildren(message);
      vscode.postMessage({ type: 'reloadPdf' });
    });

    function scrollToSourceLocation(pageElement, viewport) {
      if (target.h === undefined || target.v === undefined) {
        pageElement.scrollIntoView({ block: 'center' });
        return;
      }
      const point = syncPointToViewport(target.h, target.v, viewport);
      const desiredLeft = pageElement.offsetLeft + point[0] - viewer.clientWidth * 0.5;
      const desiredTop = pageElement.offsetTop + point[1] - viewer.clientHeight * 0.4;
      viewer.scrollTo({ left: Math.max(0, desiredLeft), top: Math.max(0, desiredTop), behavior: 'auto' });
    }

    function highlightSourceLocation(pageElement, viewport) {
      if (target.h === undefined || target.v === undefined) return;
      const point = syncPointToViewport(target.h, target.v, viewport);
      const highlight = document.createElement('div');
      highlight.className = 'sync-highlight';
      const textItems = [...pageElement.querySelectorAll('.text-item')];
      const textCandidates = textItems.map(item => {
        const rect = item.getBoundingClientRect();
        const pageRect = pageElement.getBoundingClientRect();
        const left = rect.left - pageRect.left;
        const top = rect.top - pageRect.top;
        const centerX = left + rect.width / 2;
        const centerY = top + rect.height / 2;
        return { item, left, top, width: rect.width, height: rect.height, distance: Math.hypot(centerX - point[0], centerY - point[1]) };
      });
      const nearestText = textCandidates.sort((first, second) => first.distance - second.distance)[0];
      const textTarget = nearestText && nearestText.distance <= Math.max(48, (target.height ?? 0) * viewport.scale * 3) ? nearestText : undefined;
      if (textTarget) {
        textTarget.item.classList.add('sync-text-highlight');
        highlight.style.width = Math.max(12, textTarget.width + 6) + 'px';
        highlight.style.height = Math.max(12, textTarget.height + 6) + 'px';
        highlight.style.left = (textTarget.left + textTarget.width / 2) + 'px';
        highlight.style.top = (textTarget.top + textTarget.height / 2) + 'px';
      } else {
        const width = Math.max(12, (target.width ?? 16) * viewport.scale);
        const height = Math.max(12, (target.height ?? 12) * viewport.scale);
        highlight.style.width = width + 'px';
        highlight.style.height = height + 'px';
        highlight.style.left = (point[0] + width / 2) + 'px';
        highlight.style.top = (point[1] - height / 2) + 'px';
      }
      pageElement.append(highlight);
      window.setTimeout(() => { highlight.remove(); textTarget?.item.classList.remove('sync-text-highlight'); }, 3200);
    }

    function addTextLayer(pageElement, viewport, textContent) {
      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      for (const item of textContent.items) {
        if (!('str' in item) || !item.str) continue;
        const transform = pdfjs.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(transform[2], transform[3]);
        const angle = Math.atan2(transform[1], transform[0]);
        const span = document.createElement('span');
        span.className = 'text-item';
        span.textContent = item.str;
        span.style.left = transform[4] + 'px';
        span.style.top = (transform[5] - fontHeight) + 'px';
        span.style.fontSize = fontHeight + 'px';
        span.style.transform = 'rotate(' + angle + 'rad)';
        textLayer.append(span);
      }
      pageElement.append(textLayer);
    }

    function syncPointToViewport(h, v, viewport) {
      return viewport.convertToViewportPoint(h, viewport.viewBox[3] - v);
    }

    async function renderPdf(bytes) {
      try {
        pdfjs ??= await import(pdfJsUri);
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUri;
        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        viewer.replaceChildren();
        let sourceTarget;
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const pdfPage = await pdf.getPage(pageNumber);
          const viewport = pdfPage.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) throw new Error('Could not create PDF rendering context.');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const pageElement = document.createElement('section');
          pageElement.className = 'page';
          pageElement.dataset.pageNumber = String(pageNumber);
          pageElement.append(canvas);
          pageElement.addEventListener('dblclick', event => {
            const textItem = event.target instanceof Element ? event.target.closest('.text-item') : undefined;
            if (!textItem) {
              vscode.postMessage({ type: 'syncMiss', message: 'Double-click a rendered text item, not empty space or an image.' });
              return;
            }
            const bounds = canvas.getBoundingClientRect();
            const scaleX = canvas.width / bounds.width;
            const scaleY = canvas.height / bounds.height;
            const toSyncTex = (clientX, clientY) => {
              const point = viewport.convertToPdfPoint((clientX - bounds.left) * scaleX, (clientY - bounds.top) * scaleY);
              return { h: point[0], v: viewport.viewBox[3] - point[1] };
            };
            const textItems = [...pageElement.querySelectorAll('.text-item')];
            const selectedIndex = textItems.indexOf(textItem);
            const nearbyItems = textItems.slice(Math.max(0, selectedIndex - 2), selectedIndex + 3);
            const candidates = [toSyncTex(event.clientX, event.clientY), ...nearbyItems.flatMap(item => {
              const rect = item.getBoundingClientRect();
              return [.2, .5, .8].flatMap(x => [.35, .65, .9].map(y => toSyncTex(rect.left + rect.width * x, rect.top + rect.height * y)));
            })];
            const unique = candidates.filter((candidate, index, all) => all.findIndex(other => Math.abs(other.h - candidate.h) < .5 && Math.abs(other.v - candidate.v) < .5) === index);
            const primary = unique[0];
            vscode.postMessage({ type: 'openSource', page: pageNumber, h: primary.h, v: primary.v, nearby: unique.slice(1, 12), identifier: textItem.textContent?.trim() || undefined });
          });
          viewer.append(pageElement);
          await pdfPage.render({ canvasContext: context, viewport }).promise;
          addTextLayer(pageElement, viewport, await pdfPage.getTextContent());
          if (pageNumber === target.page) sourceTarget = { pageElement, viewport };
        }
        if (sourceTarget) {
          scrollToSourceLocation(sourceTarget.pageElement, sourceTarget.viewport);
          highlightSourceLocation(sourceTarget.pageElement, sourceTarget.viewport);
        }
      } catch (error) {
        viewer.replaceChildren(message);
        message.textContent = 'Unable to render the compiled PDF: ' + (error instanceof Error ? error.message : String(error));
      }
    }

    window.addEventListener('message', event => {
      const data = event.data;
      if (data.type === 'pdfData') void renderPdf(new Uint8Array(data.bytes));
      if (data.type === 'pdfError') { viewer.replaceChildren(message); message.textContent = data.message; }
    });
    vscode.postMessage({ type: 'previewReady' });
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
