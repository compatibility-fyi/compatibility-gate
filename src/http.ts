export async function readLimitedText(
  response: Response,
  maximumBytes: number,
  label = "API",
): Promise<string> {
  const overflowMessage = `${label} response exceeded ${maximumBytes} bytes`;
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) {
    await response.body?.cancel();
    throw new Error(overflowMessage);
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(overflowMessage);
      }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
