const mb = (value) => value * 1024 * 1024;

function positiveNumber(env, name, fallback, maximum = 1000) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

export function loadFileLimits(env = process.env) {
  return {
    imageBytes: mb(positiveNumber(env, "MAX_IMAGE_MB", 10, 50)),
    pdfBytes: mb(positiveNumber(env, "MAX_PDF_MB", 20, 50)),
    documentBytes: mb(positiveNumber(env, "MAX_DOCUMENT_MB", 15, 50)),
    spreadsheetBytes: mb(positiveNumber(env, "MAX_SPREADSHEET_MB", 15, 50)),
    presentationBytes: mb(positiveNumber(env, "MAX_PRESENTATION_MB", 20, 50)),
    archiveBytes: mb(positiveNumber(env, "MAX_ARCHIVE_MB", 20, 50)),
    pdfPagesForVision: Math.floor(positiveNumber(env, "MAX_PDF_PAGES_FOR_VISION", 3, 20)),
    presentationSlidesForVision: Math.floor(positiveNumber(env, "MAX_PRESENTATION_SLIDES_FOR_VISION", 3, 20)),
    archiveFiles: Math.floor(positiveNumber(env, "MAX_ARCHIVE_FILES", 50, 500)),
    archiveExtractedBytes: mb(positiveNumber(env, "MAX_ARCHIVE_EXTRACTED_MB", 50, 250)),
  };
}

export function maxBytesForKind(kind, limits) {
  if (kind === "image") return limits.imageBytes;
  if (kind === "pdf") return limits.pdfBytes;
  if (["xls", "xlsx", "csv", "ods"].includes(kind)) return limits.spreadsheetBytes;
  if (["ppt", "pptx", "odp"].includes(kind)) return limits.presentationBytes;
  if (kind === "zip") return limits.archiveBytes;
  return limits.documentBytes;
}
