import path from "node:path";

export const SUPPORTED_TYPES = {
  ".jpg": { kind: "image", mime: ["image/jpeg"] },
  ".jpeg": { kind: "image", mime: ["image/jpeg"] },
  ".png": { kind: "image", mime: ["image/png"] },
  ".webp": { kind: "image", mime: ["image/webp"] },
  ".pdf": { kind: "pdf", mime: ["application/pdf"] },
  ".docx": { kind: "docx", mime: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] },
  ".txt": { kind: "txt", mime: ["text/plain"] },
  ".csv": { kind: "csv", mime: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"] },
  ".xlsx": { kind: "xlsx", mime: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] },
  ".pptx": { kind: "pptx", mime: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"] },
};

export class FileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function inspectFilename(filename) {
  if (!filename || filename !== path.basename(filename) || /[\0-\x1f\x7f]/.test(filename)) {
    throw new FileError("unsafe_filename", "Bos, nama fail ni tidak selamat.");
  }
  const extension = path.extname(filename).toLocaleLowerCase("en-US");
  const type = SUPPORTED_TYPES[extension];
  if (!type) throw new FileError("unsupported", "Bos, format fail ni belum disokong.");
  return { extension, ...type };
}

export function validateMime(type, mime = "") {
  if (!mime || mime === "application/octet-stream") return;
  if (!type.mime.includes(mime.toLocaleLowerCase("en-US"))) {
    throw new FileError("mime_mismatch", "Bos, jenis sebenar fail ni tak sepadan dengan namanya.");
  }
}

export function validateSignature(buffer, extension) {
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const valid = extension === ".jpg" || extension === ".jpeg"
    ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
    : extension === ".png"
      ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : extension === ".webp"
        ? buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP"
        : extension === ".pdf"
          ? buffer.subarray(0, 5).toString() === "%PDF-"
          : [".docx", ".xlsx", ".pptx"].includes(extension)
            ? zip
            : !buffer.includes(0);
  if (!valid) throw new FileError("signature", "Bos, kandungan fail ni tak sepadan dengan formatnya.");
}
