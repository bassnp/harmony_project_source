/**
 * fieldCatalogue.test.ts — Unit tests for the field catalogue loader.
 */

import { describe, expect, it, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadFieldCatalogue,
  getFormFields,
  getSemanticMap,
  _resetCache,
} from "@/lib/pdf/fieldCatalogue";
import type { FieldCatalogue } from "@/lib/pdf/fieldCatalogue";

/** Minimal valid catalogue fixture. */
const FIXTURE: FieldCatalogue = {
  version: "1.0.0",
  generated_at: "2026-01-01T00:00:00.000Z",
  mode: "direct",
  forms: [
    {
      form_id: "HCD_476_6G",
      filename: "hcd-rt-476-6g.pdf",
      fields: [
        {
          name: "Decal (License) No.(s) (page 1):",
          type: "text",
          page: 0,
          rect: [10, 20, 30, 40],
          value: null,
          semantic_label: "decal_number",
        },
        {
          name: "Serial No.(s) (page 1):",
          type: "text",
          page: 0,
          rect: [50, 60, 70, 80],
          value: null,
          semantic_label: "serial_number",
        },
      ],
    },
    {
      form_id: "HCD_476_6",
      filename: "hcd-rt-476-6.pdf",
      fields: [
        {
          name: "Decal (License) Number",
          type: "text",
          page: 0,
          rect: null,
          value: null,
          semantic_label: "decal_number",
        },
      ],
    },
    {
      form_id: "HCD_480_5",
      filename: "hcd-rt-480-5.pdf",
      fields: [
        {
          name: "NEW DECAL #:",
          type: "text",
          page: 0,
          rect: [1, 2, 3, 4],
          value: null,
          semantic_label: "new_decal_number",
        },
      ],
    },
  ],
  semantic_map: {
    HCD_476_6G: { "Decal (License) No.(s) (page 1):": "decal_number" },
    HCD_476_6: { "Decal (License) Number": "decal_number" },
    HCD_480_5: { "NEW DECAL #:": "new_decal_number" },
  },
};

describe("fieldCatalogue", () => {
  let tmpFile: string;

  afterEach(() => {
    _resetCache();
  });

  function writeFixture(): string {
    const dir = path.join(tmpdir(), `fc-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    tmpFile = path.join(dir, "field_catalogue.json");
    writeFileSync(tmpFile, JSON.stringify(FIXTURE), "utf-8");
    return tmpFile;
  }

  describe("loadFieldCatalogue()", () => {
    it("loads and parses a valid catalogue file", () => {
      const p = writeFixture();
      const cat = loadFieldCatalogue(p);

      expect(cat.version).toBe("1.0.0");
      expect(cat.forms).toHaveLength(3);
    });

    it("caches the result across calls", () => {
      const p = writeFixture();
      const a = loadFieldCatalogue(p);
      const b = loadFieldCatalogue(p);

      expect(a).toBe(b); // same reference
    });

    it("throws on missing file", () => {
      expect(() => loadFieldCatalogue("/nonexistent/path.json")).toThrow();
    });

    it("throws on malformed JSON (syntax error)", () => {
      const dir = path.join(tmpdir(), `fc-test-bad-json-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "field_catalogue.json");
      writeFileSync(p, "{ not valid json !!!", "utf-8");

      expect(() => loadFieldCatalogue(p)).toThrow(/Failed to parse/);
    });

    it("throws on structurally invalid catalogue (missing forms)", () => {
      const dir = path.join(tmpdir(), `fc-test-no-forms-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "field_catalogue.json");
      writeFileSync(p, JSON.stringify({ version: "1.0.0" }), "utf-8");

      expect(() => loadFieldCatalogue(p)).toThrow(/Invalid field catalogue/);
    });

    it("throws on empty forms array", () => {
      const dir = path.join(tmpdir(), `fc-test-empty-forms-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "field_catalogue.json");
      const bad = { ...FIXTURE, forms: [] };
      writeFileSync(p, JSON.stringify(bad), "utf-8");

      expect(() => loadFieldCatalogue(p)).toThrow(/Invalid field catalogue/);
    });

    it("throws on field with missing required name", () => {
      const dir = path.join(tmpdir(), `fc-test-no-name-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "field_catalogue.json");
      const bad = JSON.parse(JSON.stringify(FIXTURE));
      bad.forms[0].fields[0].name = "";
      writeFileSync(p, JSON.stringify(bad), "utf-8");

      expect(() => loadFieldCatalogue(p)).toThrow(/Invalid field catalogue/);
    });
  });

  describe("getFormFields()", () => {
    it("returns the correct form entry", () => {
      writeFixture();
      _resetCache();
      loadFieldCatalogue(tmpFile);

      const form = getFormFields("HCD_476_6G");
      expect(form.form_id).toBe("HCD_476_6G");
      expect(form.fields).toHaveLength(2);
    });

    it("throws for unknown form_id", () => {
      writeFixture();
      _resetCache();
      loadFieldCatalogue(tmpFile);

      expect(() => getFormFields("NONEXISTENT")).toThrow(/not found/);
    });
  });

  describe("getSemanticMap()", () => {
    it("returns semantic_label → field_name map", () => {
      writeFixture();
      _resetCache();
      loadFieldCatalogue(tmpFile);

      const map = getSemanticMap("HCD_476_6G");

      expect(map.get("decal_number")).toBe("Decal (License) No.(s) (page 1):");
      expect(map.get("serial_number")).toBe("Serial No.(s) (page 1):");
      expect(map.size).toBe(2);
    });

    it("returns empty map for form with no semantic labels", () => {
      writeFixture();
      _resetCache();

      // Patch fixture to remove semantic labels
      const modified = JSON.parse(JSON.stringify(FIXTURE));
      modified.forms[2].fields[0].semantic_label = null;
      const dir = path.join(tmpdir(), `fc-test-nolabel-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "field_catalogue.json");
      writeFileSync(p, JSON.stringify(modified), "utf-8");

      loadFieldCatalogue(p);
      const map = getSemanticMap("HCD_480_5");
      expect(map.size).toBe(0);
    });
  });
});
