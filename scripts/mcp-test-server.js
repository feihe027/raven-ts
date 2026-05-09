#!/usr/bin/env node

const PROTOCOL_VERSION = "2024-11-05";

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on("end", () => {
  process.exit(0);
});

function drainInput() {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const headers = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const contentLength = parseContentLength(headers);
    if (contentLength === undefined) {
      inputBuffer = Buffer.alloc(0);
      sendError(null, -32700, "Missing Content-Length header");
      return;
    }

    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) {
      return;
    }

    const rawMessage = inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(bodyEnd);

    try {
      handleMessage(JSON.parse(rawMessage));
    } catch (err) {
      sendError(null, -32700, err instanceof Error ? err.message : String(err));
    }
  }
}

function parseContentLength(headers) {
  for (const line of headers.split("\r\n")) {
    const match = /^content-length:\s*(\d+)$/i.exec(line.trim());
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

function handleMessage(message) {
  if (!message || typeof message !== "object") {
    sendError(null, -32600, "Invalid JSON-RPC message");
    return;
  }

  const { id, method, params } = message;
  if (id === undefined) {
    return;
  }

  switch (method) {
    case "initialize":
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "raven-ts-test-mcp",
          version: "0.1.0",
        },
      });
      return;

    case "ping":
      sendResponse(id, {});
      return;

    case "tools/list":
      sendResponse(id, {
        tools: [
          {
            name: "echo",
            description: "Return the provided text.",
            inputSchema: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                  description: "Text to echo back.",
                },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
          {
            name: "now",
            description: "Return the server's current ISO timestamp.",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      });
      return;

    case "tools/call":
      handleToolCall(id, params);
      return;

    default:
      sendError(id, -32601, `Unknown method: ${method}`);
  }
}

function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === "echo") {
    const text = typeof args.text === "string" ? args.text : "";
    sendResponse(id, {
      content: [
        {
          type: "text",
          text,
        },
      ],
    });
    return;
  }

  if (name === "now") {
    sendResponse(id, {
      content: [
        {
          type: "text",
          text: new Date().toISOString(),
        },
      ],
    });
    return;
  }

  sendError(id, -32602, `Unknown tool: ${name}`);
}

function sendResponse(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
