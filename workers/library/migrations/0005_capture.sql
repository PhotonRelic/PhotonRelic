-- What the browser knew about the original at upload time: the capture date
-- and camera the prep tool strips before the file leaves the user's machine,
-- carried in its manifest or read from the file's own EXIF in the browser.
-- Never GPS, serial numbers or owner names. The Worker never parses image
-- bytes, so a Rescan leaves these null. Additive: nothing here rewrites a row.

ALTER TABLE assets ADD COLUMN captured_at TEXT;       -- ISO 8601 as the camera wrote it, no timezone guessed
ALTER TABLE assets ADD COLUMN camera TEXT;            -- make and model, joined
ALTER TABLE assets ADD COLUMN lens TEXT;
ALTER TABLE assets ADD COLUMN original_width INTEGER; -- the pixel size before the prep tool resized it
ALTER TABLE assets ADD COLUMN original_height INTEGER;
