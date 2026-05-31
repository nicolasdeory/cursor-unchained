import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const DEFAULT_CURSOR_WORKBENCH =
  "/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js";
export const DEFAULT_CURSOR_APP = "/Applications/Cursor.app";
export const DEFAULT_CAPTURE_PORT = 17879;
export const DEFAULT_CAPTURE_DIR = "captures/cursor-runtime";

const MARKER = "__CURSOR_UNCHAINED_CPP_CAPTURE_V1__";
const STREAM_MARKER = "__CURSOR_UNCHAINED_STREAM_CPP_DIRECT_CAPTURE_V1__";
const STATE_FILE = "patch-state.json";
const AE_ANCHOR = "getType(){return Object.getPrototypeOf(this).constructor}}}});";
const GE_ANCHOR = '}},_(U7h,"Message"),Ge=U7h,_(nXg,"makeMessageType"),';

const TARGET_TYPES = [
  "aiserver.v1.StreamCppRequest",
  "aiserver.v1.StreamCppResponse",
  "aiserver.v1.CppConfigRequest",
  "aiserver.v1.CppConfigResponse",
  "aiserver.v1.RefreshTabContextRequest",
  "aiserver.v1.RefreshTabContextResponse",
  "aiserver.v1.RecordCppFateRequest",
  "aiserver.v1.RecordCppFateResponse",
];

type PatchState = {
  schema: 1;
  patchedAt: string;
  workbenchPath: string;
  backupPath: string;
  originalSize: number;
  patchedSize: number;
};

export type InstrumentStatus = {
  workbenchPath: string;
  patched: boolean;
  markerCount: number;
  state?: PatchState;
};

function captureDir() {
  return process.env.CURSOR_CAPTURE_DIR ?? DEFAULT_CAPTURE_DIR;
}

function statePath() {
  return path.join(captureDir(), STATE_FILE);
}

function appCopyPath() {
  return process.env.CURSOR_INSTRUMENTED_APP_PATH
    ? path.resolve(process.env.CURSOR_INSTRUMENTED_APP_PATH)
    : path.resolve(captureDir(), "Cursor Instrumented.app");
}

function workbenchPathForApp(appPath: string) {
  return path.join(
    appPath,
    "Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js",
  );
}

function plistBuddy(appPath: string, commands: string[]) {
  const plistPath = path.join(appPath, "Contents/Info.plist");
  const args = commands.flatMap((command) => ["-c", command]);
  execFileSync("/usr/libexec/PlistBuddy", [...args, plistPath], {
    stdio: "inherit",
  });
}

function readJsonSafe(filePath: string): PatchState | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as PatchState;
  } catch {
    return undefined;
  }
}

function writeJson(filePath: string, data: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function markerCount(text: string) {
  return text.split(MARKER).length - 1;
}

function runtimeSnippet() {
  return `;(()=>{const M="${MARKER}";if(globalThis[M])return;globalThis[M]=true;const T=new Set(${JSON.stringify(TARGET_TYPES)});const P=${DEFAULT_CAPTURE_PORT};const bytesToBase64=(buf)=>{try{const u=buf instanceof Uint8Array?buf:new Uint8Array(buf);let s="";for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode(...u.subarray(i,i+32768));return btoa(s)}catch(e){return{error:String(e)}}};const redact=(k,v)=>{if(/authorization|bearer|token|secret|api[-_]?key|cookie/i.test(k))return"[redacted]";if(typeof v==="bigint")return v.toString();if(v instanceof Uint8Array)return{byteLength:v.byteLength,base64:bytesToBase64(v)};return v};const safe=(v)=>{try{return JSON.parse(JSON.stringify(v,redact))}catch(e){return{serializationError:String(e)}}};const send=(event)=>{try{const body=JSON.stringify({...event,capturedAt:new Date().toISOString(),cursorCaptureMarker:M});const url="http://127.0.0.1:"+P+"/capture";if(typeof navigator!=="undefined"&&navigator.sendBeacon){const ok=navigator.sendBeacon(url,new Blob([body],{type:"application/json"}));if(ok)return}fetch(url,{method:"POST",headers:{"content-type":"application/json"},body,keepalive:true}).catch(()=>{})}catch(e){}};globalThis.__cursorUnchainedCapture=send;globalThis.__cursorUnchainedBytesToBase64=bytesToBase64;globalThis.__cursorUnchainedSafeMessage=safe;send({schema:1,source:"cursor-app",kind:"boot"});globalThis.__cursorUnchainedPatchProto=(Base,label)=>{try{if(!Base||!Base.prototype||Base.prototype.__cursorUnchainedPatched)return;Object.defineProperty(Base.prototype,"__cursorUnchainedPatched",{value:true});for(const name of["toBinary","fromBinary","fromJson","fromJsonString"]){const original=Base.prototype[name];if(typeof original!=="function")continue;Base.prototype[name]=function(...args){const start=performance.now();let out,err;try{out=original.apply(this,args);return out}catch(e){err=e;throw e}finally{try{const type=this.getType?.().typeName; if(T.has(type)){send({schema:1,source:"cursor-app",runtime:label,kind:name,typeName:type,direction:name==="toBinary"?"encode":"decode",durationMs:Math.round((performance.now()-start)*1000)/1000,byteLength:args[0]?.byteLength??args[0]?.length??out?.byteLength??out?.length,ok:!err,error:err?String(err):undefined,message:safe(this)})}}catch(e){}}}}}catch(e){send({schema:1,source:"cursor-app",kind:"patch-error",runtime:label,error:String(e)})}};const origFetch=globalThis.fetch;if(typeof origFetch==="function"&&!origFetch.__cursorUnchainedPatched){const wrapped=async function(input,init){const start=performance.now();const url=typeof input==="string"?input:input?.url;const method=init?.method??input?.method;const headers={};try{new Headers(init?.headers??input?.headers).forEach((v,k)=>headers[k]=redact(k,v))}catch{}try{const res=await origFetch.apply(this,arguments);if(/\\/aiserver\\.v1\\.|Cpp|cpp/i.test(String(url)))send({schema:1,source:"cursor-app",kind:"fetch",url:String(url),method,status:res.status,durationMs:Math.round((performance.now()-start)*1000)/1000,headers});return res}catch(e){if(/\\/aiserver\\.v1\\.|Cpp|cpp/i.test(String(url)))send({schema:1,source:"cursor-app",kind:"fetch-error",url:String(url),method,durationMs:Math.round((performance.now()-start)*1000)/1000,headers,error:String(e)});throw e}};wrapped.__cursorUnchainedPatched=true;globalThis.fetch=wrapped}})();`;
}

function patchStreamCppDirect(text: string) {
  if (text.includes(STREAM_MARKER)) {
    return text;
  }
  const before =
    "await h.streamCpp(ro.wrap(new yId({...b,modelName:this.getModelName(),diffHistoryKeys:[],contextItems:[],parameterHints:this._cppTypeService.getRelevantParameterHints(e),lspSuggestedItems:E,lspContexts:[],filesyncUpdates:[],workspaceId:k,timeSinceRequestStart:performance.now()+performance.timeOrigin-c.startOfCpp,timeAtRequestSend:Date.now(),codeResults:this.cachedTabContext?.results??[]}).toBinary()),{generateUuid:s,startOfCpp:c.startOfCpp});";
  const after =
    `(globalThis.__cursorUnchainedStreamMarker="${STREAM_MARKER}",globalThis.__cursorUnchainedRequest=new yId({...b,modelName:this.getModelName(),diffHistoryKeys:[],contextItems:[],parameterHints:this._cppTypeService.getRelevantParameterHints(e),lspSuggestedItems:E,lspContexts:[],filesyncUpdates:[],workspaceId:k,timeSinceRequestStart:performance.now()+performance.timeOrigin-c.startOfCpp,timeAtRequestSend:Date.now(),codeResults:this.cachedTabContext?.results??[]}),globalThis.__cursorUnchainedBytes=globalThis.__cursorUnchainedRequest.toBinary(),globalThis.__cursorUnchainedBase64=(()=>{const u=globalThis.__cursorUnchainedBytes;let z="";for(let x=0;x<u.length;x+=32768)z+=String.fromCharCode(...u.subarray(x,x+32768));return btoa(z)})(),globalThis.__cursorUnchainedEvent={schema:1,source:"cursor-app",kind:"stream-cpp-request-direct",typeName:"aiserver.v1.StreamCppRequest",generationUUID:s,modelName:this.getModelName(),byteLength:globalThis.__cursorUnchainedBytes.byteLength,requestBodyBase64:globalThis.__cursorUnchainedBase64,message:globalThis.__cursorUnchainedSafeMessage?.(globalThis.__cursorUnchainedRequest)},fetch("http://127.0.0.1:${DEFAULT_CAPTURE_PORT}/capture",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...globalThis.__cursorUnchainedEvent,capturedAt:new Date().toISOString()})}).catch(()=>{}),await h.streamCpp(ro.wrap(globalThis.__cursorUnchainedBytes),{generateUuid:s,startOfCpp:c.startOfCpp}));`;
  if (!text.includes(before)) {
    return text;
  }
  return text.replace(before, after);
}

export function patchText(text: string) {
  let patched = text;
  if (!patched.includes(MARKER)) {
    if (!patched.includes(AE_ANCHOR)) {
      throw new Error("Could not find Cursor protobuf ae base anchor");
    }
    if (!patched.includes(GE_ANCHOR)) {
      throw new Error("Could not find Cursor protobuf Ge base anchor");
    }

    patched = patched.replace(AE_ANCHOR, `${AE_ANCHOR}${runtimeSnippet()}globalThis.__cursorUnchainedPatchProto?.(ae,"ae");`);
    patched = patched.replace(GE_ANCHOR, `${GE_ANCHOR}globalThis.__cursorUnchainedPatchProto?.(Ge,"Ge"),`);
  }
  return patchStreamCppDirect(patched);
}

function backupDir() {
  return path.join(captureDir(), "backups");
}

function backupNameFor(workbenchPath: string) {
  return `${path.basename(workbenchPath)}.cursor-capture-backup`;
}

function latestBackupFor(workbenchPath: string) {
  if (!fs.existsSync(backupDir())) {
    return undefined;
  }
  const backupName = backupNameFor(workbenchPath);
  const latest = fs
    .readdirSync(backupDir())
    .filter((entry) => entry.startsWith(`${backupName}.`))
    .sort()
    .at(-1);
  return latest ? path.join(backupDir(), latest) : undefined;
}

export function getStatus(workbenchPath = DEFAULT_CURSOR_WORKBENCH): InstrumentStatus {
  const text = fs.readFileSync(workbenchPath, "utf8");
  return {
    workbenchPath,
    patched: text.includes(MARKER),
    markerCount: markerCount(text),
    state: readJsonSafe(statePath()),
  };
}

export function patchCursor(workbenchPath = DEFAULT_CURSOR_WORKBENCH) {
  const original = fs.readFileSync(workbenchPath, "utf8");
  const patched = patchText(original);
  if (patched === original) {
    return getStatus(workbenchPath);
  }

  fs.mkdirSync(backupDir(), { recursive: true });
  const backupPath = path.join(
    backupDir(),
    `${backupNameFor(workbenchPath)}.${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  fs.copyFileSync(workbenchPath, backupPath);
  fs.writeFileSync(workbenchPath, patched);
  const state: PatchState = {
    schema: 1,
    patchedAt: new Date().toISOString(),
    workbenchPath,
    backupPath,
    originalSize: original.length,
    patchedSize: patched.length,
  };
  writeJson(statePath(), state);
  return getStatus(workbenchPath);
}

export function restoreCursor(workbenchPath = DEFAULT_CURSOR_WORKBENCH) {
  const state = readJsonSafe(statePath());
  const backupPath =
    state?.workbenchPath === workbenchPath && fs.existsSync(state.backupPath)
      ? state.backupPath
      : latestBackupFor(workbenchPath);
  if (!backupPath) {
    throw new Error("No Cursor capture backup found");
  }
  fs.copyFileSync(backupPath, workbenchPath);
  return getStatus(workbenchPath);
}

export function prepareInstrumentedApp(
  sourceApp = DEFAULT_CURSOR_APP,
  destinationApp = appCopyPath(),
) {
  if (!fs.existsSync(destinationApp)) {
    fs.mkdirSync(path.dirname(destinationApp), { recursive: true });
    execFileSync("ditto", ["--noextattr", "--noqtn", sourceApp, destinationApp], {
      stdio: "inherit",
    });
  }
  plistBuddy(destinationApp, [
    "Set :CFBundleIdentifier com.todesktop.230313mzl4w4u92.instrumented",
    "Set :CFBundleDisplayName Cursor Instrumented",
    "Set :CFBundleName Cursor",
  ]);
  const workbenchPath = workbenchPathForApp(destinationApp);
  const status = patchCursor(workbenchPath);
  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", destinationApp], {
      stdio: "ignore",
    });
  } catch {
    // No quarantine attribute is fine; ditto --noqtn should usually avoid it.
  }
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", destinationApp], {
    stdio: "inherit",
  });
  return {
    appPath: destinationApp,
    executablePath: path.join(destinationApp, "Contents/MacOS/Cursor"),
    workbenchPath,
    status,
  };
}

function captureFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(captureDir(), `${day}.jsonl`);
}

function appendCapture(record: unknown) {
  fs.mkdirSync(captureDir(), { recursive: true });
  fs.appendFileSync(captureFilePath(), `${JSON.stringify(record)}\n`);
}

export function serveCapture(port = Number(process.env.CURSOR_CAPTURE_PORT ?? DEFAULT_CAPTURE_PORT)) {
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response(JSON.stringify({ ok: true }), {
          headers,
        });
      }
      if (req.method === "POST" && url.pathname === "/capture") {
        const body = await req.json().catch(() => ({}));
        appendCapture(body);
        return new Response(JSON.stringify({ ok: true }), {
          headers,
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers,
      });
    },
  });
}

if (import.meta.main) {
  const command = Bun.argv[2] ?? "status";
  const workbenchPath = Bun.argv[3] ?? process.env.CURSOR_WORKBENCH_PATH ?? DEFAULT_CURSOR_WORKBENCH;

  if (command === "patch") {
    console.log(JSON.stringify(patchCursor(workbenchPath), null, 2));
  } else if (command === "restore") {
    console.log(JSON.stringify(restoreCursor(workbenchPath), null, 2));
  } else if (command === "status") {
    console.log(JSON.stringify(getStatus(workbenchPath), null, 2));
  } else if (command === "prepare-copy") {
    console.log(
      JSON.stringify(
        prepareInstrumentedApp(
          process.env.CURSOR_SOURCE_APP ?? DEFAULT_CURSOR_APP,
          Bun.argv[3] ?? appCopyPath(),
        ),
        null,
        2,
      ),
    );
  } else if (command === "serve") {
    const server = serveCapture();
    console.log(`Cursor capture server listening on http://${server.hostname}:${server.port}/capture`);
  } else {
    console.error("Usage: bun run scripts/cursorInstrumentation.ts [patch|restore|status|prepare-copy|serve] [path]");
    process.exit(1);
  }
}
