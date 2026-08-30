import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { getSignedReleaseUrl } from "../app/signed-release-url.mjs";

async function render(releaseUrl) {
  const previous = process.env.YOREBOT_SIGNED_RELEASE_URL;

  if (releaseUrl === undefined) {
    delete process.env.YOREBOT_SIGNED_RELEASE_URL;
  } else {
    process.env.YOREBOT_SIGNED_RELEASE_URL = releaseUrl;
  }

  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
    const { default: worker } = await import(workerUrl.href);

    return await worker.fetch(
      new Request("http://localhost/", {
        headers: { accept: "text/html" },
      }),
      {
        ASSETS: {
          fetch: async () => new Response("Not found", { status: 404 }),
        },
      },
      {
        waitUntil() {},
        passThroughOnException() {},
      },
    );
  } finally {
    if (previous === undefined) {
      delete process.env.YOREBOT_SIGNED_RELEASE_URL;
    } else {
      process.env.YOREBOT_SIGNED_RELEASE_URL = previous;
    }
  }
}

test("unconfigured site renders one simple route and no download link", async () => {
  const response = await render(undefined);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  const visibleHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  assert.match(html, /<title>YoreBot \| Private help on your computer<\/title>/i);
  assert.match(html, /Chat privately/);
  assert.match(html, /Organize Downloads/);
  assert.match(html, /approve the exact change/i);
  assert.match(html, /Windows release is being prepared/i);
  assert.doesNotMatch(visibleHtml, /being signed|we are signing/i);
  assert.doesNotMatch(html, /<a[^>]*>[^<]*Download for Windows/i);
  assert.doesNotMatch(html, /(?:href|src)=["']https?:\/\//i);
  assert.doesNotMatch(
    visibleHtml,
    /Qwen|llama|runtime|provider|checkout|analytics|cookies?|available now|launch now/i,
  );

  const appEntries = await readdir(new URL("../app/", import.meta.url), {
    recursive: true,
  });
  assert.deepEqual(
    appEntries.filter((entry) => entry.endsWith("page.tsx")),
    ["page.tsx"],
  );
});

test("valid signed installer URL is preserved exactly and becomes the only download target", async () => {
  const exact =
    "https://github.com/emv-dev/YoreBot/releases/download/v2.0.0/YoreBot-2.0.0-setup.exe";
  assert.equal(getSignedReleaseUrl(exact), exact);

  const response = await render(exact);
  const html = await response.text();
  assert.match(
    html,
    /href="https:\/\/github\.com\/emv-dev\/YoreBot\/releases\/download\/v2\.0\.0\/YoreBot-2\.0\.0-setup\.exe"/,
  );
  assert.match(html, />Download for Windows/);
  assert.equal((html.match(/class="primary-action"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Windows release is being prepared/i);
});

test("invalid or ambiguous release URLs fail closed", async () => {
  const invalid = [
    undefined,
    "",
    " /YoreBot-setup.exe",
    "/YoreBot-setup.exe",
    "http://downloads.example.com/YoreBot-setup.exe",
    "https://downloads.example.com/",
    "https://downloads.example.com/YoreBot-setup.exe",
    "https://downloads.example.com/YoreBot.zip",
    "https://github.com/other/YoreBot/releases/download/v2/YoreBot-setup.exe",
    "https://github.com/emv-dev/Other/releases/download/v2/YoreBot-setup.exe",
    "https://github.com/emv-dev/YoreBot/releases/latest/download/YoreBot-setup.exe",
    "https://github.com/emv-dev/YoreBot/releases/download/v2/Other-setup.exe",
    "https://github.com:444/emv-dev/YoreBot/releases/download/v2/YoreBot-setup.exe",
    "https://user:secret@github.com/emv-dev/YoreBot/releases/download/v2/YoreBot-setup.exe",
    "https://github.com/emv-dev/YoreBot/releases/download/v2/YoreBot-setup.exe?download=1",
    "https://github.com/emv-dev/YoreBot/releases/download/v2/YoreBot-setup.exe#look-here",
    "https://github.com/emv-dev/YoreBot/releases/download/v2/YoreBot-setup.exe ",
    "javascript:alert(1)",
  ];

  for (const candidate of invalid) {
    assert.equal(getSignedReleaseUrl(candidate), null, String(candidate));
  }

  const response = await render("https://downloads.example.com/YoreBot-setup.exe");
  const html = await response.text();
  assert.doesNotMatch(html, /<a[^>]*>[^<]*Download for Windows/i);
  assert.match(html, /Windows release is being prepared/i);
  assert.doesNotMatch(html, /being signed|we are signing/i);
});

test("approval preview depicts exactly one move mutation", async () => {
  const response = await render(undefined);
  const html = await response.text();
  const renderedCard = html.match(
    /<div class="approval-card">([\s\S]*?)<div class="approval-actions"/,
  )?.[1];
  assert.ok(renderedCard);
  assert.equal((renderedCard.match(/<p>/g) ?? []).length, 1);
  assert.match(renderedCard, /<p>Move<\/p>/);
  assert.match(renderedCard, /invoice\.pdf → Documents \/ invoice\.pdf/);
  assert.doesNotMatch(renderedCard, /Create folder/);

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const cardStart = page.indexOf('<div className="approval-card">');
  const cardEnd = page.indexOf('<div className="approval-actions"', cardStart);
  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  const sourceCard = page.slice(cardStart, cardEnd);
  assert.equal((sourceCard.match(/<p>/g) ?? []).length, 1);
  assert.match(sourceCard, /<p>Move<\/p>/);
  assert.doesNotMatch(sourceCard, /Create folder|Downloads \/ Documents/);
});

test("starter preview and remote asset remnants are absent", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  assert.doesNotMatch(page + layout + css, /_sites-preview|codex-preview|next\/font\/google/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(page + layout + css, /https?:\/\//i);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(page, /className="skip-link"/);
});
