import { Project } from "ts-morph";
import express, { Express, Request, Response } from "express";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { randomUUID } from "crypto";
import { once } from "events";
import { createRequire } from "module";
import { pathToFileURL } from "url";

const DEFAULT_GENERATED_CLIENT_PATH = path.resolve(process.cwd(), "frontend/client.ts");
const DEFAULT_FRONTEND_DIR = path.resolve(process.cwd(), "static");
const DEFAULT_MAX_MULTIPART_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_MAX_MULTIPART_FIELD_BYTES = 1024 * 1024;
const CRLF = "\r\n";
const DEFAULT_MULTIPART_TMP_DIR = path.join(os.tmpdir(), "gold-uploads");

// ── Types ──────────────────────────────────────────────────────────────────────────────

export interface UploadedFile {
  fieldName: string;
  filename: string;
  contentType: string;
  size: number;
  tempFilePath: string;
  createReadStream: () => fs.ReadStream;
  readAsBuffer: () => Promise<Buffer>;
}

interface ParamInfo {
  name: string;
  typeText: string;
  isOptional: boolean;
  kind: "body" | "file";
}

interface RouteInfo {
  methodName: string;
  namespaceName: string;
  paramInfos: ParamInfo[];
  returnTypeText: string;
  isSSE: boolean;
  sseEventType: string | null;
  dispatchKey: string;
}

export interface GildOptions {
  /** Port to listen on. Default: 3000 */
  port?: number;
  /** Enable dev mode: Vite HMR middleware + file watcher. Default: false */
  dev?: boolean;
  /** Where to write the generated TypeScript client. Default: frontend/client.ts */
  generatedClientPath?: string;
  /** Directory to serve static files from in production. Default: static/ */
  frontendDir?: string;
  /** Max multipart/form-data request size in bytes. Default: 8 GB */
  maxMultipartBytes?: number;
  /** Max size of a single non-file form field in bytes. Default: 1 MB */
  maxMultipartFieldBytes?: number;
  /** Directory to write uploaded temp files to. Default: OS temp dir */
  multipartTmpDir?: string;
}

interface MultipartLimits {
  maxBytes: number;
  maxFieldBytes: number;
  tmpDir: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────

function filePathToNamespace(filePath: string): string {
  const name = path.basename(filePath, ".ts").replace(/^Api|Api$/g, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function unwrapPromise(t: string): string {
  return t.replace(/^Promise<([\s\S]+)>$/, "$1");
}

function extractSSEEventType(t: string): string | null {
  const m = t.match(/^Async(?:Generator|Iterable(?:Iterator)?)<([\s\S]+)>/);
  if (!m) return null;
  let depth = 0;
  for (let i = 0; i < m[1].length; i++) {
    if (m[1][i] === "<") depth++;
    else if (m[1][i] === ">") depth--;
    else if (m[1][i] === "," && depth === 0) return m[1].slice(0, i).trim();
  }
  return m[1].trim() || null;
}

function inferParamKind(typeText: string): ParamInfo["kind"] {
  return /UploadedFile/.test(typeText) ? "file" : "body";
}

function clientParamType(p: ParamInfo): string {
  return p.kind === "file" ? "File | Blob" : p.typeText;
}

async function createViteServerFromCwd() {
  const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
  const viteEntry = requireFromCwd.resolve("vite");
  const viteModule = await import(pathToFileURL(viteEntry).href);
  return viteModule.createServer as (options: {
    root: string;
    server: { middlewareMode: true };
    appType: "spa";
  }) => Promise<{ middlewares: express.RequestHandler }>;
}

// ── Multipart parser ──────────────────────────────────────────────────────────────────

interface ParsedPayload {
  fields: Record<string, unknown>;
  files: Record<string, UploadedFile | UploadedFile[]>;
}

function addEntry<T>(target: Record<string, T | T[]>, key: string, value: T): void {
  const existing = target[key];
  if (existing === undefined) { target[key] = value; return; }
  if (Array.isArray(existing)) { existing.push(value); return; }
  target[key] = [existing, value];
}

function coerceField(raw: string): unknown {
  const t = raw.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { return JSON.parse(t) as unknown; } catch { /* fall through */ }
  }
  return raw;
}

function parseContentDisposition(value: string): { name?: string; filename?: string } {
  const name = value.match(/name="([^"]*)"/i)?.[1] ?? value.match(/name=([^;]+)/i)?.[1]?.trim();
  const filename = value.match(/filename="([^"]*)"/i)?.[1] ?? value.match(/filename=([^;]+)/i)?.[1]?.trim();
  return { name, filename };
}

async function writeChunk(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
}

async function parseMultipart(req: Request, limits: MultipartLimits): Promise<ParsedPayload> {
  const ct = req.headers["content-type"] ?? "";
  const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = bm?.[1] ?? bm?.[2];
  if (!boundary) throw new Error("Multipart boundary missing");

  fs.mkdirSync(limits.tmpDir, { recursive: true });

  const boundaryLine = Buffer.from(`--${boundary}`);
  const boundaryWithCrlf = Buffer.from(`\r\n--${boundary}`);
  const headerDelimiter = Buffer.from("\r\n\r\n");
  const bodyTailSize = boundaryWithCrlf.length + 8;

  const fields: Record<string, unknown> = {};
  const files: Record<string, UploadedFile | UploadedFile[]> = {};

  let totalBytes = 0;
  let buffer = Buffer.alloc(0);
  let state: "preamble" | "headers" | "body" | "done" = "preamble";

  let partFieldName = "";
  let partFileName: string | undefined;
  let partContentType: string | undefined;
  let partFilePath: string | undefined;
  let partFileStream: fs.WriteStream | null = null;
  let partFileSize = 0;
  let partFieldChunks: Buffer[] = [];
  let partFieldSize = 0;

  const resetPart = () => {
    partFieldName = "";
    partFileName = undefined;
    partContentType = undefined;
    partFilePath = undefined;
    partFileStream = null;
    partFileSize = 0;
    partFieldChunks = [];
    partFieldSize = 0;
  };

  const consumeBody = async (chunk: Buffer) => {
    if (chunk.length === 0) return;
    if (partFileStream) {
      await writeChunk(partFileStream, chunk);
      partFileSize += chunk.length;
      return;
    }
    partFieldSize += chunk.length;
    if (partFieldSize > limits.maxFieldBytes) throw new Error("Multipart field too large");
    partFieldChunks.push(Buffer.from(chunk));
  };

  const finalizePart = async () => {
    if (!partFieldName) return;
    if (partFileStream && partFilePath && partFileName) {
      const finalizedPath = partFilePath;
      partFileStream.end();
      await once(partFileStream, "close");
      addEntry(files, partFieldName, {
        fieldName: partFieldName,
        filename: partFileName,
        contentType: partContentType ?? "application/octet-stream",
        size: partFileSize,
        tempFilePath: finalizedPath,
        createReadStream: () => fs.createReadStream(finalizedPath),
        readAsBuffer: () => fs.promises.readFile(finalizedPath),
      });
    } else {
      addEntry(fields, partFieldName, coerceField(Buffer.concat(partFieldChunks).toString("utf8")));
    }
    resetPart();
  };

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > limits.maxBytes) throw new Error("Payload too large");
    buffer = Buffer.concat([buffer, buf]);

    while (buffer.length > 0) {
      if (state === "done") { buffer = Buffer.alloc(0); break; }

      if (state === "preamble") {
        const idx = buffer.indexOf(boundaryLine);
        if (idx === -1) {
          const keep = Math.min(buffer.length, boundaryLine.length);
          buffer = buffer.subarray(buffer.length - keep);
          break;
        }
        buffer = buffer.subarray(idx + boundaryLine.length);
        if (buffer.length < 2) break;
        if (buffer[0] === 45 && buffer[1] === 45) { state = "done"; break; }
        if (buffer[0] !== 13 || buffer[1] !== 10) throw new Error("Invalid multipart boundary framing");
        buffer = buffer.subarray(2);
        state = "headers";
        continue;
      }

      if (state === "headers") {
        const headerEnd = buffer.indexOf(headerDelimiter);
        if (headerEnd === -1) break;
        const rawHeaders = buffer.subarray(0, headerEnd).toString("utf8");
        buffer = buffer.subarray(headerEnd + headerDelimiter.length);

        const headerLines = rawHeaders.split(CRLF);
        const disposition = headerLines.find((l) => l.toLowerCase().startsWith("content-disposition:"));
        if (!disposition) throw new Error("Multipart part missing Content-Disposition");
        const { name, filename } = parseContentDisposition(disposition);
        if (!name) throw new Error("Multipart part missing field name");

        partFieldName = name;
        partFileName = filename;
        partContentType = headerLines
          .find((l) => l.toLowerCase().startsWith("content-type:"))
          ?.split(":")[1]?.trim();

        if (partFileName) {
          partFilePath = path.join(limits.tmpDir, `${randomUUID()}-${path.basename(partFileName)}`);
          partFileStream = fs.createWriteStream(partFilePath);
        }
        state = "body";
        continue;
      }

      // state === "body"
      const boundaryIdx = buffer.indexOf(boundaryWithCrlf);
      if (boundaryIdx === -1) {
        if (buffer.length <= bodyTailSize) break;
        const emit = buffer.subarray(0, buffer.length - bodyTailSize);
        buffer = buffer.subarray(buffer.length - bodyTailSize);
        await consumeBody(emit);
        continue;
      }

      await consumeBody(buffer.subarray(0, boundaryIdx));
      buffer = buffer.subarray(boundaryIdx + 2);
      await finalizePart();

      if (buffer.length < boundaryLine.length + 2) break;
      if (!buffer.subarray(0, boundaryLine.length).equals(boundaryLine)) throw new Error("Invalid multipart boundary");

      const markerIdx = boundaryLine.length;
      const b0 = buffer[markerIdx];
      const b1 = buffer[markerIdx + 1];
      if (b0 === 45 && b1 === 45) { buffer = buffer.subarray(markerIdx + 2); state = "done"; continue; }
      if (b0 !== 13 || b1 !== 10) throw new Error("Invalid multipart separator");
      buffer = buffer.subarray(markerIdx + 2);
      state = "headers";
    }
  }

  if (state !== "done") throw new Error("Incomplete multipart payload");
  return { fields, files };
}

async function parsePayload(req: Request, limits: MultipartLimits): Promise<ParsedPayload> {
  if (req.headers["content-type"]?.includes("multipart/form-data")) return parseMultipart(req, limits);
  return { fields: (req.body ?? {}) as Record<string, unknown>, files: {} };
}

// ── Route registration ────────────────────────────────────────────────────────────────

function registerRequestRoute(
  app: Express,
  dispatch: Map<string, { route: RouteInfo; handler: (...args: unknown[]) => Promise<unknown> | unknown }>,
  limits: MultipartLimits
): void {
  app.post("/gold_request", async (req, res) => {
    try {
      const payload = await parsePayload(req, limits);
      const methodKey = payload.fields.__method;
      if (typeof methodKey !== "string") { res.status(400).json({ error: "Missing __method" }); return; }
      const entry = dispatch.get(methodKey);
      if (!entry) { res.status(404).json({ error: `Unknown method: ${methodKey}` }); return; }
      const { route, handler } = entry;
      const args = route.paramInfos.map((p): unknown =>
        p.kind === "file" ? payload.files[p.name] : payload.fields[p.name]
      );
      res.json(await handler(...args));
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  console.log(`  → POST /gold_request (${dispatch.size} methods: ${[...dispatch.keys()].join(", ")})`);
}

function registerSSERoute(
  app: Express,
  dispatch: Map<string, { route: RouteInfo; handler: (...args: unknown[]) => AsyncGenerator<unknown> }>
): void {
  app.post("/gold_sse", async (req, res) => {
    const entry = dispatch.get(req.body.__method as string);
    if (!entry) { res.status(404).json({ error: `Unknown method: ${req.body.__method as string}` }); return; }
    const { route, handler } = entry;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const args = route.paramInfos.map((p): unknown => req.body[p.name]);
    const generator = handler(...args);
    let closed = false;
    const close = () => { closed = true; void generator.return(undefined); };
    res.on("close", close);
    req.on("aborted", close);

    try {
      for await (const data of generator) {
        if (closed) break;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    } catch (err: unknown) {
      if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
    }

    if (!closed) res.end();
  });
  console.log(`  → POST /gold_sse (${dispatch.size} methods: ${[...dispatch.keys()].join(", ")})`);
}

// ── Dev mode ──────────────────────────────────────────────────────────────────────────

function setupDevMode(backendDir: string): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  fs.watch(backendDir, { recursive: true }, (_event, filename) => {
    if (typeof filename !== "string" || !filename.endsWith(".ts")) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log(`🔄 Gild: ${filename} changed — restarting…`);
      process.exit(0);
    }, 100);
  });
  console.log(`🔍 Gild: Watching ${backendDir} for changes`);
}

// ── Client generation ─────────────────────────────────────────────────────────────────

function sseMethod(route: RouteInfo): string {
  const evType = route.sseEventType ?? "unknown";
  const dataSig = route.paramInfos.map((p) => {
    const t = clientParamType(p);
    if (!p.isOptional) return `${p.name}: ${t}`;
    return `${p.name}: ${t.includes("|") ? `(${t}) | undefined` : `${t} | undefined`}`;
  }).join(", ");
  const sep = dataSig ? ", " : "";
  const fields = route.paramInfos.map((p) => p.name).join(", ");
  const body = fields
    ? `{ __method: "${route.dispatchKey}", ${fields} }`
    : `{ __method: "${route.dispatchKey}" }`;

  return (
    `    ${route.methodName}(${dataSig}${sep}` +
    `callback: (data: ${evType}) => void, onError?: (err: Event) => void): () => void {\n` +
    `      const _ctrl = new AbortController();\n` +
    `      fetch('/gold_sse', { method: 'POST', headers: { 'Content-Type': 'application/json' },\n` +
    `        body: JSON.stringify(${body}), signal: _ctrl.signal }).then(async (res) => {\n` +
    `        if (!res.ok || !res.body) { if (onError) onError(new Event('error')); return; }\n` +
    `        const reader = res.body.getReader(), decoder = new TextDecoder();\n` +
    `        let buf = '';\n` +
    `        try {\n` +
    `          while (true) {\n` +
    `            const { done, value } = await reader.read();\n` +
    `            if (done) break;\n` +
    `            buf += decoder.decode(value, { stream: true });\n` +
    `            const lines = buf.split('\\n'); buf = lines.pop() ?? '';\n` +
    `            for (const line of lines)\n` +
    `              if (line.startsWith('data: ')) callback(JSON.parse(line.slice(6)) as unknown as ${evType});\n` +
    `          }\n` +
    `        } catch { if (!_ctrl.signal.aborted && onError) onError(new Event('error')); }\n` +
    `      }).catch(() => { if (!_ctrl.signal.aborted && onError) onError(new Event('error')); });\n` +
    `      return () => _ctrl.abort();\n` +
    `    },`
  );
}

function requestMethod(route: RouteInfo): string {
  const paramSig = route.paramInfos
    .map((p) => `${p.name}${p.isOptional ? "?" : ""}: ${clientParamType(p)}`)
    .join(", ");
  const ret = `ApiResponse<${route.returnTypeText}>`;
  const hasFile = route.paramInfos.some((p) => p.kind === "file");
  const returnsNoBody = /^(void|undefined)$/.test(route.returnTypeText.trim());
  const parseResult = returnsNoBody
    ? `return undefined as unknown as ${route.returnTypeText};`
    : `const _text = await r.text();\n` +
      `          if (!_text) throw new Error("Expected JSON response body");\n` +
      `          return JSON.parse(_text) as ${route.returnTypeText};`;

  if (hasFile) {
    let form = `      const _form = new FormData();\n`;
    form += `      _form.append("__method", "${route.dispatchKey}");\n`;
    for (const p of route.paramInfos) {
      if (p.kind === "file") {
        form += `      if (${p.name} != null) {\n`;
        form += `        if (Array.isArray(${p.name})) { for (const _f of ${p.name}) _form.append("${p.name}", _f as Blob); }\n`;
        form += `        else _form.append("${p.name}", ${p.name} as Blob);\n`;
        form += `      }\n`;
      } else {
        form += `      if (${p.name} != null) _form.append("${p.name}", _toFormValue(${p.name}));\n`;
      }
    }
    return (
      `    ${route.methodName}(${paramSig}): ${ret} {\n` +
      form +
      `      return fetch('/gold_request', { method: "POST", body: _form })\n` +
      `        .then(async r => {\n` +
      `          if (!r.ok) throw new Error(\`HTTP \${r.status}\`);\n` +
      `          if (r.status === 204 || r.status === 205 || r.headers.get("content-length") === "0") { ${parseResult} }\n` +
      `          ${parseResult}\n` +
      `        });\n` +
      `    },`
    );
  }

  const names = route.paramInfos.map((p) => p.name).join(", ");
  const body = names
    ? `{ __method: "${route.dispatchKey}", ${names} }`
    : `{ __method: "${route.dispatchKey}" }`;
  return (
    `    ${route.methodName}(${paramSig}): ${ret} {\n` +
    `      return fetch('/gold_request', { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${body}) })\n` +
    `        .then(async r => {\n` +
    `          if (!r.ok) throw new Error(\`HTTP \${r.status}\`);\n` +
    `          if (r.status === 204 || r.status === 205 || r.headers.get("content-length") === "0") { ${parseResult} }\n` +
    `          ${parseResult}\n` +
    `        });\n` +
    `    },`
  );
}

async function generateClient(
  routes: RouteInfo[],
  interfaces: Map<string, string>,
  typeAliases: Map<string, string>,
  generatedClientPath: string
): Promise<void> {
  const needsFormValue = routes.some(
    (r) => !r.isSSE && r.paramInfos.some((p) => p.kind === "file") && r.paramInfos.some((p) => p.kind !== "file")
  );
  const lines: string[] = [
    `// AUTO-GENERATED by Gild — do not edit manually`,
    `// Generated on ${new Date().toISOString()}`,
    ``,
  ];

  for (const t of [...interfaces.values(), ...typeAliases.values()])
    lines.push(`export ${t}\n`);

  lines.push(`export type ApiResponse<T> = Promise<T>;`);
  if (needsFormValue) {
    lines.push(
      ``,
      `const _toFormValue = (value: unknown): string =>`,
      `  typeof value === 'string' ? value : JSON.stringify(value);`,
    );
  }

  const byNamespace: Record<string, string[]> = {};
  for (const route of routes)
    (byNamespace[route.namespaceName] ??= []).push(route.isSSE ? sseMethod(route) : requestMethod(route));

  lines.push(``, `const _api = {`);
  for (const [ns, methods] of Object.entries(byNamespace))
    lines.push(`  ${ns}: {`, ...methods, `  },`);
  lines.push(`} as const;`, ``, `export default _api;`);
  for (const ns of Object.keys(byNamespace))
    lines.push(`export const ${ns} = _api.${ns};`);

  fs.mkdirSync(path.dirname(generatedClientPath), { recursive: true });
  fs.writeFileSync(generatedClientPath, lines.join("\n"), "utf-8");
}

// ── Main ──────────────────────────────────────────────────────────────────────────────

export default async function gild(app: Express, options: GildOptions = {}) {
  const { port = 3000, dev = false } = options;
  const generatedClientPath = options.generatedClientPath ?? DEFAULT_GENERATED_CLIENT_PATH;
  const frontendDir = options.frontendDir ?? DEFAULT_FRONTEND_DIR;
  const limits: MultipartLimits = {
    maxBytes: options.maxMultipartBytes ?? DEFAULT_MAX_MULTIPART_BYTES,
    maxFieldBytes: options.maxMultipartFieldBytes ?? DEFAULT_MAX_MULTIPART_FIELD_BYTES,
    tmpDir: options.multipartTmpDir ?? DEFAULT_MULTIPART_TMP_DIR,
  };
  app.use(express.json());

  const backendDir = path.resolve(process.cwd(), "backend");
  const apiFiles = (fs.readdirSync(backendDir, { recursive: true }) as string[])
    .filter((f): f is string => typeof f === "string" && f.endsWith("Api.ts"))
    .map((f) => path.join(backendDir, f));

  const project = new Project({
    tsConfigFilePath: path.resolve(process.cwd(), "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
  });
  apiFiles.forEach((f) => project.addSourceFileAtPathIfExists(f));

  const routes: RouteInfo[] = [];
  const interfaces = new Map<string, string>();
  const typeAliases = new Map<string, string>();
  const requestDispatch = new Map<string, { route: RouteInfo; handler: (...args: unknown[]) => Promise<unknown> | unknown }>();
  const sseDispatch = new Map<string, { route: RouteInfo; handler: (...args: unknown[]) => AsyncGenerator<unknown> }>();

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    if (!filePath.endsWith("Api.ts")) continue;

    for (const intf of sourceFile.getInterfaces()) {
      const name = intf.getName();
      if (name) interfaces.set(name, intf.getFullText().trim());
    }
    for (const ta of sourceFile.getTypeAliases()) {
      const name = ta.getName();
      if (name) typeAliases.set(name, ta.getFullText().trim());
    }

    const namespaceName = filePathToNamespace(filePath);
    const modulePath = filePath.replace(/\.ts$/, "");
    let exports: Record<string, unknown>;
    try {
      exports = (await import(`file://${modulePath}`)) as Record<string, unknown>;
    } catch (e) {
      console.warn(`Could not import ${modulePath}:`, e);
      continue;
    }

    for (const fn of sourceFile.getFunctions()) {
      if (!fn.isExported()) continue;
      const methodName = fn.getName();
      if (!methodName) continue;
      const handler = exports[methodName];
      if (typeof handler !== "function") continue;

      const rawReturn = fn.getReturnTypeNode()?.getText() ?? fn.getReturnType().getText(fn);
      const isSSE = fn.isGenerator() || /(^|\W)Async(?:Generator|Iterable(?:Iterator)?)(<|\W|$)/.test(rawReturn);
      const sseEventType = isSSE ? extractSSEEventType(rawReturn) : null;
      const returnTypeText = isSSE ? (sseEventType ?? "unknown") : unwrapPromise(rawReturn);
      const paramInfos: ParamInfo[] = fn.getParameters().map((p) => {
        const typeText = p.getTypeNode()?.getText() ?? p.getType().getText(p).replace(/\s*\|\s*undefined$/, "");
        return { name: p.getName(), typeText, isOptional: p.isOptional(), kind: inferParamKind(typeText) };
      });

      const dispatchKey = `${namespaceName}.${methodName}`;
      const route: RouteInfo = { methodName, namespaceName, paramInfos, returnTypeText, isSSE, sseEventType, dispatchKey };
      routes.push(route);
      if (isSSE) sseDispatch.set(dispatchKey, { route, handler: handler as (...args: unknown[]) => AsyncGenerator<unknown> });
      else requestDispatch.set(dispatchKey, { route, handler: handler as (...args: unknown[]) => Promise<unknown> | unknown });
    }
  }

  if (requestDispatch.size > 0) registerRequestRoute(app, requestDispatch, limits);
  if (sseDispatch.size > 0) registerSSERoute(app, sseDispatch);

  console.log(`✅ Gild: Registered ${routes.length} routes`);
  await generateClient(routes, interfaces, typeAliases, generatedClientPath);

  if (dev) {
    const createViteServer = await createViteServerFromCwd();
    const vite = await createViteServer({
      root: path.resolve(process.cwd(), "frontend"),
      server: { middlewareMode: true },
      appType: "spa",
    });
    setupDevMode(backendDir);
    app.use(vite.middlewares);
  } else {
    app.use(express.static(frontendDir));
    app.get("/*path", (_req: Request, res: Response) => {
      res.sendFile(path.join(frontendDir, "index.html"));
    });
  }

  app.listen(port, () => {
    console.log(`🚀 Gild: Server running on http://localhost:${port}`);
    console.log(`📝 Gild: Generated ${generatedClientPath}`);
  });
}
