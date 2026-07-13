-- SPDX-License-Identifier: CC0-1.0

ALTER TABLE projects ADD COLUMN active_recipes_json TEXT NOT NULL DEFAULT '["post-capture-basic","production-proxy","production-prores","production-upload","production-version-publish"]';
ALTER TABLE projects ADD COLUMN recovery_mode TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE projects ADD COLUMN recovery_note TEXT NOT NULL DEFAULT '';
