const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

function loadDotEnv(filePath = ".env") {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    }
  } catch (_error) {
    // .env file is optional
  }
}

function parseBoolean(value) {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function readAllowList(filePath) {
  try {
    const input = fs.readFileSync(filePath, { encoding: "utf-8" });
    return input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch (error) {
    console.error(
      `Failed to open \"${filePath}\"! See allowed.txt.example for a starting point.`,
    );
    return [];
  }
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>+~])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function minifyHtml(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .replace(/&apos;/g, "'")
    .trim();
}

function removeAttr(tag, attrName) {
  const attrRegex = new RegExp(
    `\\s${attrName}\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)`,
    "gi",
  );
  return tag.replace(attrRegex, "");
}

function getAttr(tag, attrName) {
  const regex = new RegExp(
    `${attrName}\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = tag.match(regex);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? null;
}

function setAttr(tag, attrName, attrValue) {
  const attrRegex = new RegExp(
    `(${attrName}\\s*=\\s*)(\"[^\"]*\"|'[^']*'|[^\\s>]+)`,
    "i",
  );
  if (attrRegex.test(tag)) {
    return tag.replace(attrRegex, `$1\"${attrValue}\"`);
  }

  if (tag.endsWith("/>")) {
    return tag.slice(0, -2) + ` ${attrName}=\"${attrValue}\"/>`;
  }

  return tag.slice(0, -1) + ` ${attrName}=\"${attrValue}\">`;
}

function processHtml(html, options) {
  const { friendly, stripJs, stripCSS, maxInlineWidth, targetUrl } = options;

  let output = html.replace(/https:\/\//g, "http://");

  if (!friendly && stripJs) {
    output = output
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<script\b[^>]*\/?>/gi, "")
      .replace(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi, "$1");
  }

  if (!friendly && stripCSS) {
    output = output
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<link\b[^>]*>/gi, "");

    output = output.replace(/<([a-z][^>]*?)>/gi, (match) => {
      if (/^<\//.test(match)) return match;
      let tag = removeAttr(match, "class");
      tag = removeAttr(tag, "style");
      return tag;
    });
  }

  if (!friendly) {
    output = output.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = getAttr(tag, "src");
      if (!src) return tag;

      let srcUrl = src;
      try {
        srcUrl = new URL(src, targetUrl).href;
      } catch (_error) {
        // keep original src if URL is malformed
      }

      if (
        srcUrl.toLowerCase().endsWith(".svg") ||
        srcUrl.toLowerCase().includes(".svg?")
      ) {
        return "";
      }

      if (
        !maxInlineWidth ||
        Number.isNaN(maxInlineWidth) ||
        maxInlineWidth <= 0
      ) {
        return tag;
      }

      const attrWidthRaw = getAttr(tag, "width");
      const attrHeightRaw = getAttr(tag, "height");
      const attrWidth = attrWidthRaw ? Number(attrWidthRaw) : NaN;
      const attrHeight = attrHeightRaw ? Number(attrHeightRaw) : NaN;

      if (Number.isFinite(attrWidth) && attrWidth > 0) {
        const width = Math.min(maxInlineWidth, attrWidth);
        let updated = setAttr(tag, "width", Math.round(width));
        if (Number.isFinite(attrHeight) && attrHeight > 0) {
          const height = (attrHeight * width) / attrWidth;
          updated = setAttr(updated, "height", Math.max(1, Math.round(height)));
        }
        return updated;
      }

      return setAttr(tag, "width", Math.round(maxInlineWidth));
    });
  }

  // Fix root-relative URLs for older browsers
  let origin = "";
  try {
    origin = new URL(targetUrl).origin;
  } catch (_error) {
    origin = "";
  }

  if (origin) {
    output = output.replace(
      /(href\s*=\s*[\"'])\/(?!\/)([^\"']*)([\"'])/gi,
      (_m, p1, p2, p3) => {
        return `${p1}${origin}/${p2}${p3}`;
      },
    );
  }

  return output;
}

function resolveTargetUrl(req) {
  const raw = req.url || "";
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  const host = req.headers.host;
  if (!host) {
    return null;
  }

  try {
    return new URL(raw, `http://${host}`).href;
  } catch (_error) {
    return null;
  }
}

function isFriendly(targetUrl, friendlies) {
  try {
    const hostname = new URL(targetUrl).hostname;
    return friendlies.some((f) => hostname === f || hostname.endsWith(`.${f}`));
  } catch (_error) {
    return false;
  }
}

function requestUrl(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(error);
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const request = client.get(
      targetUrl,
      {
        headers: {
          "accept-encoding": "identity",
          "user-agent": "retro-proxy/0.0.1",
        },
      },
      (response) => {
        const status = response.statusCode || 502;
        const headers = response.headers || {};

        if (
          status >= 300 &&
          status < 400 &&
          typeof headers.location === "string" &&
          redirectCount < 5
        ) {
          const redirectUrl = new URL(headers.location, targetUrl).href;
          response.resume();
          resolve(requestUrl(redirectUrl, redirectCount + 1));
          return;
        }

        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status,
            headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.on("error", reject);
  });
}

loadDotEnv();

const ip = process.env.IP || "";
const port = Number(process.env.PORT || 3000);
const stripCSS = parseBoolean(process.env.NO_CSS);
const stripJs = parseBoolean(process.env.NO_JS);
const maxInlineWidth = process.env.SCALE_TO
  ? Number(process.env.SCALE_TO)
  : NaN;
const allowListPath = process.env.ALLOWLIST || "allowed.txt";
const friendlies = readAllowList(allowListPath);

console.log("allow-list", friendlies);

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain");
    res.end("Only GET is supported.");
    return;
  }

  const targetUrl = resolveTargetUrl(req);
  if (!targetUrl) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain");
    res.end("Bad request URL.");
    return;
  }

  const friendly = isFriendly(targetUrl, friendlies);
  if (friendly) {
    console.log("friendly site:", targetUrl);
  }

  try {
    const upstream = await requestUrl(targetUrl);
    const contentType =
      typeof upstream.headers["content-type"] === "string"
        ? upstream.headers["content-type"]
        : "application/octet-stream";

    res.statusCode = upstream.status;
    res.setHeader("Content-Type", contentType);

    if (contentType.startsWith("text/html")) {
      const text = upstream.body.toString("utf-8");
      const processed = processHtml(text, {
        friendly,
        stripJs,
        stripCSS,
        maxInlineWidth,
        targetUrl,
      });

      if (!friendly) {
        const minified = minifyHtml(processed);
        console.log("html minified", contentType, targetUrl);
        res.end(minified);
      } else {
        res.end(processed.replace(/&apos;/g, "'"));
      }
      return;
    }

    if (contentType.startsWith("text/css")) {
      const text = upstream.body.toString("utf-8");
      const minifiedCss = minifyCss(text);
      console.log("css minified", contentType, targetUrl);
      res.end(minifiedCss);
      return;
    }

    // No dependency image conversion/compression: pass through original bytes.
    res.end(upstream.body);
  } catch (error) {
    console.error(error);
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/html");
    res.end(`<html>
  <head>
    <title>502 - Bad Gateway</title>
  </head>
  <body>
    <h1>502 - Bad Gateway</h1>
    <p>An error occurred while retrieving the page. Please check the server log for details.</p>
  </body>
</html>`);
  }
});

if (ip) {
  server.listen(port, ip);
} else {
  server.listen(port);
}

console.log(
  `Listening on port ${port}, CSS is ${stripCSS ? "disabled" : "enabled"}, image transcoding is disabled (no external libraries).`,
);
