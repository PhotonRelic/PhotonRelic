-- Where a cover crop keeps its subject: the point a person clicked on the
-- file page, as fractions of the width and height from the top-left corner
-- (0.5, 0.5 is the center). Both null means nobody chose, and the resizer
-- lets Cloudflare Images pick (gravity auto). Scale-down requests never crop,
-- so they ignore it.
ALTER TABLE assets ADD COLUMN focal_x REAL;
ALTER TABLE assets ADD COLUMN focal_y REAL;
