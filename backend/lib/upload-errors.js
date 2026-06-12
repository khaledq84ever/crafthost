// Shared upload error handler — mount at the end of any router that accepts
// multipart uploads. Converts multer errors to JSON (413 for oversized files)
// instead of Express's default HTML 500 page.
//
// catchAll: also convert non-multer errors (e.g. storage-callback failures
// like auth/path checks inside multer destination) to 400 JSON rather than
// passing them to the default handler.
const multer = require("multer");

module.exports = function uploadErrors({ catchAll = false, maxLabel } = {}) {
  return (err, req, res, next) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(413)
        .json({
          error: maxLabel
            ? `File too large (max ${maxLabel})`
            : "File too large",
        });
    }
    if (err instanceof multer.MulterError || catchAll) {
      return res.status(400).json({ error: err.message || "Upload error" });
    }
    next(err);
  };
};
