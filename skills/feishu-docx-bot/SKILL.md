---
name: feishu-docx-bot
description: Create and update Feishu/Lark Docx documents through the raven-ts Feishu bot. Use when an agent running in raven-ts needs to save research results, paper lists, reports, summaries, or generated content into Feishu Docs, then return the document token or link to the chat.
---

# Feishu Docx Bot

Use the raven-ts Feishu bot as the writer. Do not invent a separate Feishu integration.

## Workflow

1. Verify raven-ts Feishu config exists with `node dist/cli.js config list`.
2. Use the existing SDK helpers:
   - `getFeishuConfig` from `dist/config.js`
   - `createFeishuClient` from `dist/feishu/client.js`
3. Create a Docx document with `client.docx.document.create`.
4. Read the root block with `client.docx.documentBlock.list`.
5. Insert content blocks with `client.docx.documentBlockChildren.create`.
6. Send the resulting document token or URL back to the Feishu chat with `client.im.message.create` or the raven-ts reply helpers.

## Minimal Node Pattern

```js
import { getFeishuConfig } from "./dist/config.js";
import { createFeishuClient } from "./dist/feishu/client.js";

const cfg = getFeishuConfig();
if (!cfg) throw new Error("Feishu config missing");

const client = createFeishuClient(cfg);

const created = await client.docx.document.create({
  data: {
    title: "Research report",
    // folder_token: optional target folder token
  },
});

const documentId = created?.data?.document?.document_id;
if (!documentId) throw new Error("Docx create returned no document_id");

const blocks = await client.docx.documentBlock.list({
  path: { document_id: documentId },
  params: { page_size: 20 },
});
const rootBlockId = blocks?.data?.items?.[0]?.block_id || documentId;

await client.docx.documentBlockChildren.create({
  path: { document_id: documentId, block_id: rootBlockId },
  data: {
    children: [
      {
        block_type: 2,
        text: {
          elements: [
            { text_run: { content: "Report body" } },
          ],
        },
      },
    ],
  },
});
```

Use `block_type: 2` for normal paragraphs. For headings, prefer `block_type: 3` with `heading1`, `block_type: 4` with `heading2`, and plain paragraphs if a heading payload is rejected by Feishu validation.

## Research And Paper Reports

When saving paper search results:

- Search first, then write the document.
- Include paper title, authors, year, venue, DOI/arXiv URL, abstract summary, and why it matters.
- Do not fabricate DOI, arXiv IDs, venues, or dates. If metadata is uncertain, mark it as unverified.
- Keep a "Sources" section with direct URLs.
- Return the created document token and URL in the Feishu chat.

## Encoding

Write production scripts as UTF-8 files. Avoid piping Chinese text through PowerShell here-strings unless the text is escaped, because the Windows console may replace non-ASCII characters with `?`.

## Required Feishu Permissions

The app needs message send/read permissions plus Docx document permissions in the Feishu/Lark developer console. For streaming cards and permission cards, also keep the CardKit permissions documented in the raven-ts README.

At minimum for document creation and writing:

- Create Docx documents
- Read Docx document blocks
- Write/update Docx document blocks
- Optional folder write access if using `folder_token`

After changing Feishu permissions, publish a new app version and update the installed app in the tenant.
