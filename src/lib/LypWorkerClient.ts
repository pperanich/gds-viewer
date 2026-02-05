import LypWorker from "./lyp.worker.ts?worker&inline";
import type { LypParseResult, SerializedLypParseResult } from "./LypParser";
import { deserializeLypParseResult } from "./LypParser";

function handleWorkerResponse(
  worker: Worker,
  resolve: (result: LypParseResult) => void,
  reject: (error: Error) => void,
) {
  worker.onmessage = (event: MessageEvent) => {
    const { type, result, error } = event.data as {
      type: string;
      result?: SerializedLypParseResult;
      error?: string;
    };

    if (type === "complete" && result) {
      worker.terminate();
      resolve(deserializeLypParseResult(result));
    } else if (type === "error") {
      worker.terminate();
      reject(new Error(error ?? "Worker error"));
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    worker.terminate();
    reject(new Error(`Worker error: ${event.message}`));
  };
}

export async function loadLypFromUrlInWorker(
  url: string
): Promise<LypParseResult> {
  return new Promise((resolve, reject) => {
    const worker = new LypWorker();
    handleWorkerResponse(worker, resolve, reject);
    worker.postMessage({ type: "parseUrl", payload: { url } });
  });
}

export async function parseLypFileInWorker(
  xmlContent: string
): Promise<LypParseResult> {
  return new Promise((resolve, reject) => {
    const worker = new LypWorker();
    handleWorkerResponse(worker, resolve, reject);
    worker.postMessage({ type: "parseText", payload: { xmlContent } });
  });
}

export async function loadLypFromFileInWorker(
  file: File
): Promise<LypParseResult> {
  const xmlContent = await file.text();
  return parseLypFileInWorker(xmlContent);
}
