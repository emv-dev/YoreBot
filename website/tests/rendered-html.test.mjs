import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { getSignedReleaseUrl } from "../app/signed-release-url.mjs";
import { getSocialImageUrl } from "../app/social-image-url.mjs";

async function render(releaseUrl, requestUrl = "http://localhost/", extraHeaders = {}) {
  const previous = process.env.YOREBOT_SIGNED_RELEASE_URL;
  const request = new URL(requestUrl);

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
      new Request(request, {
        headers: {
          accept: "text/html",
          host: request.host,
          "x-forwarded-host": request.host,
          "x-forwarded-proto": request.protocol.slice(0, -1),
          ...extraHeaders,
        },
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

function metaContent(html, attribute, value) {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = html.match(
    new RegExp(
      `<meta(?=[^>]*\\b${attribute}=["']${escapedValue}["'])[^>]*>`,
      "i",
    ),
  )?.[0];
  return tag?.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? null;
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

test("root social metadata matches the page and uses only the request-host card", async () => {
  const response = await render(undefined, "https://preview.yorebot.test/");
  const html = await response.text();
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null;
  const description = metaContent(html, "name", "description");
  const imageUrl = "https://preview.yorebot.test/og.png";

  assert.equal(title, "YoreBot | Private help on your computer");
  assert.equal(
    description,
    "Private local chat and a Downloads organizer that asks before changing files.",
  );
  assert.equal(metaContent(html, "property", "og:title"), title);
  assert.equal(metaContent(html, "property", "og:description"), description);
  assert.equal(metaContent(html, "name", "twitter:title"), title);
  assert.equal(metaContent(html, "name", "twitter:description"), description);
  assert.equal(metaContent(html, "name", "twitter:card"), "summary_large_image");
  assert.equal(metaContent(html, "property", "og:image"), imageUrl);
  assert.equal(metaContent(html, "name", "twitter:image"), imageUrl);
  assert.equal((html.match(/property="og:image"/g) ?? []).length, 1);
  assert.equal((html.match(/name="twitter:image"/g) ?? []).length, 1);

  const image = await readFile(new URL("../public/og.png", import.meta.url));
  assert.ok(image.length > 100_000);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(image.readUInt32BE(16) >= 1_200);
  assert.ok(image.readUInt32BE(20) >= 630);
});

test("ambiguous forwarded hosts omit social images instead of using a fallback", async () => {
  const response = await render(undefined, "https://preview.yorebot.test/", {
    "x-forwarded-host": "attacker.example, preview.yorebot.test",
  });
  const html = await response.text();
  assert.equal(metaContent(html, "property", "og:image"), null);
  assert.equal(metaContent(html, "name", "twitter:image"), null);
  assert.doesNotMatch(html, /starter|placeholder|fallback-og/i);
});

test("conflicting valid host headers emit no rendered social image", async () => {
  const response = await render(undefined, "https://preview.yorebot.test/", {
    "x-forwarded-host": "attacker.example",
  });
  const html = await response.text();
  assert.equal(metaContent(html, "property", "og:image"), null);
  assert.equal(metaContent(html, "name", "twitter:image"), null);
});

test("social image hosts agree canonically or fail closed", () => {
  assert.equal(
    getSocialImageUrl({
      host: "PREVIEW.YOREBOT.TEST:443",
      forwardedHost: "preview.yorebot.test",
      forwardedProto: "https",
    }),
    "https://preview.yorebot.test/og.png",
  );
  assert.equal(
    getSocialImageUrl({
      host: "preview.yorebot.test",
      forwardedHost: null,
      forwardedProto: "https",
    }),
    "https://preview.yorebot.test/og.png",
  );
  assert.equal(
    getSocialImageUrl({
      host: null,
      forwardedHost: "preview.yorebot.test",
      forwardedProto: "https",
    }),
    "https://preview.yorebot.test/og.png",
  );
  assert.equal(
    getSocialImageUrl({
      host: "preview.yorebot.test:444",
      forwardedHost: "preview.yorebot.test",
      forwardedProto: "https",
    }),
    null,
  );
  assert.equal(
    getSocialImageUrl({
      host: "invalid host",
      forwardedHost: "preview.yorebot.test",
      forwardedProto: "https",
    }),
    null,
  );
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
