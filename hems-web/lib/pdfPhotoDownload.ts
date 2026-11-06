import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
export const MAX_PDF_PHOTO_BYTES = 8 * 1024 * 1024;
export const isPublicPhotoAddress = (value: string) => isIP(value) === 4 && !blocked.check(value, "ipv4");

export class PdfPhotoDownloadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "PdfPhotoDownloadError"; this.code = code; }
}
function denied(): never { throw new PdfPhotoDownloadError("SOURCE_NOT_ALLOWED", "This photo source is not allowed."); }

export function parsePublicPhotoUrl(value: string): URL {
  if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) denied();
  let url: URL;
  try { url = new URL(value); } catch { return denied(); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash
    || url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) denied();
  const host = url.hostname.toLowerCase();
  // Restrict outbound connections to public IPv4. IPv6 literals/IPv6-only
  // hosts are deliberately unsupported; no mapped/private IPv6 loopholes.
  if (!host || host.endsWith(".") || host.includes(":") || !host.includes(".")
    || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host)
    || isIP(host) && !isPublicPhotoAddress(host)) denied();
  return url;
}

type DownloadDependencies = {
  resolve: (hostname: string) => Promise<string[]>;
  request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
};
const defaults: DownloadDependencies = {
  resolve: async hostname => (await lookup(hostname, { family: 4, all: true })).map(entry => entry.address),
  request: (url, options, callback) => url.protocol === "https:"
    ? httpsRequest(options, callback) : httpRequest(options, callback),
};

async function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new PdfPhotoDownloadError("PHOTO_TIMEOUT", "Photo download was cancelled or timed out.");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new PdfPhotoDownloadError("PHOTO_TIMEOUT", "Photo download was cancelled or timed out."));
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Connect only to a checked IP, preserving Host/TLS SNI. No second DNS lookup
 * can rebind a public hostname to a private service. Recheck every redirect. */
export async function downloadPublicPdfPhoto(source: string, signal: AbortSignal, deps = defaults): Promise<Buffer> {
  let url = parsePublicPhotoUrl(source);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const addresses = isIP(url.hostname) ? [url.hostname] : await abortable(deps.resolve(url.hostname), signal);
    if (!addresses.length || addresses.some(address => !isPublicPhotoAddress(address))) denied();
    if (signal.aborted) throw new PdfPhotoDownloadError("PHOTO_TIMEOUT", "Photo download was cancelled or timed out.");
    const response = await new Promise<{ bytes?: Buffer; redirect?: string }>((resolve, reject) => {
      const options: RequestOptions = {
        protocol: url.protocol, hostname: addresses[0], port: url.protocol === "https:" ? 443 : 80,
        servername: isIP(url.hostname) ? undefined : url.hostname, path: url.pathname + url.search, method: "GET", agent: false, signal,
        headers: { Host: url.host, Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/tiff",
          "Accept-Encoding": "identity", "User-Agent": "Hilights-EMS-PDF/1.0" },
      };
      const request = deps.request(url, options, res => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.destroy(); resolve({ redirect: res.headers.location }); return;
        }
        if (status < 200 || status >= 300) {
          res.destroy(); reject(new PdfPhotoDownloadError("PHOTO_HOST_ERROR", `The photo host returned HTTP ${status}.`)); return;
        }
        const mime = (res.headers["content-type"] ?? "").trim();
        if (mime && !/^image\/(png|jpe?g|webp|gif|avif|tiff|heif|heic)(?:;|$)/i.test(mime)
          && !/^application\/octet-stream(?:;|$)/i.test(mime)) {
          res.destroy(); reject(new PdfPhotoDownloadError("NOT_AN_IMAGE", "The photo host did not return a supported image.")); return;
        }
        if (Number(res.headers["content-length"] ?? 0) > MAX_PDF_PHOTO_BYTES) {
          res.destroy(); reject(new PdfPhotoDownloadError("PHOTO_TOO_LARGE", "The source photo exceeds 8 MB.")); return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        res.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_PDF_PHOTO_BYTES) {
            res.destroy(); request.destroy(); reject(new PdfPhotoDownloadError("PHOTO_TOO_LARGE", "The source photo exceeds 8 MB."));
          } else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("aborted", () => reject(new PdfPhotoDownloadError("PHOTO_INTERRUPTED", "The photo download was interrupted.")));
        res.on("end", () => resolve({ bytes: Buffer.concat(chunks) }));
      });
      request.on("error", reject);
      request.setTimeout(7000, () => request.destroy(new PdfPhotoDownloadError("PHOTO_TIMEOUT", "The photo host timed out.")));
      request.end();
    });
    if (response.bytes) {
      if (!isRasterPhoto(response.bytes)) throw new PdfPhotoDownloadError("NOT_AN_IMAGE", "The downloaded file is not a supported raster image.");
      return response.bytes;
    }
    if (!response.redirect || redirects === 3) throw new PdfPhotoDownloadError("TOO_MANY_REDIRECTS", "The photo host redirected too many times.");
    const next = parsePublicPhotoUrl(new URL(response.redirect, url).href);
    if (url.protocol === "https:" && next.protocol !== "https:") denied();
    url = next;
  }
  throw new PdfPhotoDownloadError("PHOTO_HOST_ERROR", "The photo could not be downloaded.");
}

/** Check actual file signatures before handing data to the image decoder.
 * In particular, never pass SVG/XML/HTML to Sharp even if mislabeled PNG. */
export function isRasterPhoto(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  return bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
    || ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))
    || bytes.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis", "heic", "heix", "mif1", "msf1"].includes(bytes.toString("ascii", 8, 12))
    || bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]));
}
