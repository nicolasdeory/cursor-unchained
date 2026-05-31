const CDP_PORT = Number(process.env.CURSOR_CDP_PORT ?? "17880");
const CAPTURE_PORT = Number(process.env.CURSOR_CAPTURE_PORT ?? "17879");

type CdpTarget = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

function browserSnippet() {
  return `(()=>{const M="__CURSOR_UNCHAINED_CDP_CAPTURE_V4__";if(globalThis[M]){globalThis.__cursorUnchainedCdpPing?.();return "already-installed"}globalThis[M]=true;const P=${CAPTURE_PORT};const enc=(buf)=>{const u=new Uint8Array(buf);let s="";for(let i=0;i<u.length;i+=0x8000)s+=String.fromCharCode(...u.subarray(i,i+0x8000));return btoa(s)};const redact=(k,v)=>/authorization|bearer|token|secret|api[-_]?key|cookie/i.test(k)?"[redacted]":v;const headers=(h)=>{const out={};try{new Headers(h).forEach((v,k)=>out[k]=redact(k,v))}catch{}return out};const isInteresting=(url)=>/\\/aiserver\\.v1\\.|Cpp|cpp/i.test(String(url));const send=(event)=>{try{fetch("http://127.0.0.1:"+P+"/capture",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...event,capturedAt:new Date().toISOString(),cursorCaptureMarker:M}),keepalive:true}).catch((e)=>console.debug("cursor capture send failed",e))}catch(e){console.debug("cursor capture send threw",e)}};globalThis.__cursorUnchainedCdpPing=()=>send({schema:1,source:"cursor-cdp",kind:"ping"});const bodyBytes=async(body)=>{try{if(!body)return null;if(body instanceof ArrayBuffer)return enc(body);if(ArrayBuffer.isView(body))return enc(body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength));if(body instanceof Blob)return enc(await body.arrayBuffer());if(typeof body==="string")return btoa(unescape(encodeURIComponent(body)));return null}catch(e){return {error:String(e)}}};const oldFetch=globalThis.fetch;if(typeof oldFetch==="function"){const wrapped=async function(input,init){const started=performance.now();const url=typeof input==="string"?input:input?.url;const method=init?.method??input?.method;const interesting=isInteresting(url);let requestBody=null;if(interesting)requestBody=await bodyBytes(init?.body??input?.body);try{const res=await oldFetch.apply(this,arguments);if(interesting){const cloned=res.clone();cloned.arrayBuffer().then((buf)=>send({schema:1,source:"cursor-cdp",kind:"fetch",url:String(url),method,status:res.status,durationMs:Math.round((performance.now()-started)*1000)/1000,requestHeaders:headers(init?.headers??input?.headers),responseHeaders:headers(res.headers),requestBodyBase64:requestBody,responseBodyBase64:enc(buf)})).catch((e)=>send({schema:1,source:"cursor-cdp",kind:"fetch-response-error",url:String(url),method,status:res.status,error:String(e)}))}return res}catch(e){if(interesting)send({schema:1,source:"cursor-cdp",kind:"fetch-error",url:String(url),method,durationMs:Math.round((performance.now()-started)*1000)/1000,requestHeaders:headers(init?.headers??input?.headers),requestBodyBase64:requestBody,error:String(e)});throw e}};wrapped.__cursorUnchainedCdpPatched=true;globalThis.fetch=wrapped}globalThis.__cursorUnchainedCdpPing();return "installed";})();`;
}

async function targets() {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  if (!response.ok) {
    throw new Error(`CDP target list failed with HTTP ${response.status}`);
  }
  return (await response.json()) as CdpTarget[];
}

function cdpCall(
  socket: WebSocket,
  id: number,
  method: string,
  params: Record<string, unknown>,
) {
  socket.send(JSON.stringify({ id, method, params }));
}

async function injectTarget(target: CdpTarget) {
  if (!target.webSocketDebuggerUrl) {
    return { target, injected: false, reason: "missing-websocket-url" };
  }

  const expression = browserSnippet();
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl!);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out injecting ${target.title || target.url}`));
    }, 10000);
    const results: unknown[] = [];

    socket.onopen = () => {
      cdpCall(socket, 0, "Runtime.enable", {});
      cdpCall(socket, 1, "Page.addScriptToEvaluateOnNewDocument", { source: expression });
      cdpCall(socket, 2, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
    };
    socket.onmessage = async (event) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof Blob
            ? await event.data.text()
            : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      const message = JSON.parse(data);
      if (message.id === 1 || message.id === 2) {
        results.push(message);
      }
      if (results.length >= 2) {
        clearTimeout(timeout);
        socket.close();
        resolve({ target, injected: true, results });
      }
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`CDP websocket error for ${target.title || target.url}`));
    };
  });
}

export async function injectCursorCdp() {
  const allTargets = await targets();
  const pageTargets = allTargets.filter((target) =>
    ["page", "webview", "iframe"].includes(target.type),
  );
  const results = [];
  for (const target of pageTargets) {
    try {
      results.push(await injectTarget(target));
    } catch (error) {
      results.push({
        target,
        injected: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await injectCursorCdp(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      `Start stock Cursor with: open -n -a /Applications/Cursor.app --args --remote-debugging-port=${CDP_PORT}`,
    );
    process.exit(1);
  }
}
