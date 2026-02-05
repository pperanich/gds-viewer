import { parseLypFile, serializeLypParseResult } from "./LypParser";

self.onmessage = async (event: MessageEvent) => {
  const { type, payload } = event.data as {
    type: string;
    payload: { url?: string; xmlContent?: string };
  };

  try {
    let xmlContent = payload.xmlContent;

    if (type === "parseUrl") {
      const response = await fetch(payload.url!);
      if (!response.ok) {
        throw new Error(`Failed to fetch LYP file: ${response.statusText}`);
      }
      xmlContent = await response.text();
    }

    if (!xmlContent) {
      throw new Error("No LYP content provided");
    }

    const result = parseLypFile(xmlContent);
    const serialized = serializeLypParseResult(result);
    self.postMessage({ type: "complete", result: serialized });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    self.postMessage({ type: "error", error: message });
  }
};
