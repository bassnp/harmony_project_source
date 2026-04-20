/**
 * extractedSchema.test — Unit tests for the HCD title extracted fields schema.
 *
 * Covers: valid complete input, minimal required fields, missing required fields,
 * empty owners array, and extra/optional fields.
 */

import { describe, it, expect } from "vitest";
import { ExtractedFieldsSchema } from "@/lib/pdf/extractedSchema";

describe("ExtractedFieldsSchema", () => {
  it("validates a complete extraction", () => {
    const data = {
      decal_number: "LAA12345",
      serial_number: "S12345678",
      trade_name: "Fleetwood",
      manufacturer_name: "Fleetwood Enterprises",
      manufacture_date: "2005",
      model_name: "Weston",
      owners: [
        {
          name: "John Doe",
          mailing_address: "123 Main St",
          city: "Sacramento",
          state: "CA",
          zip: "95814",
          phone: "555-0100",
          email: "john@example.com",
        },
      ],
      situs_address: "456 Park Ave",
      situs_city: "Sacramento",
      situs_state: "CA",
      situs_zip: "95814",
      sale_price: "$50,000",
      sale_date: "2024-01-15",
      notes: "Unit in good condition",
    };

    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates minimal required fields only", () => {
    const data = {
      decal_number: "LAA12345",
      serial_number: "S12345678",
      owners: [{ name: "Jane Doe" }],
    };

    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("rejects missing decal_number", () => {
    const data = {
      serial_number: "S12345678",
      owners: [{ name: "Jane Doe" }],
    };

    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects missing serial_number", () => {
    const data = {
      decal_number: "LAA12345",
      owners: [{ name: "Jane Doe" }],
    };

    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects empty owners array", () => {
    const data = {
      decal_number: "LAA12345",
      serial_number: "S12345678",
      owners: [],
    };

    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("accepts multiple owners", () => {
    const data = {
      decal_number: "LAA12345",
      serial_number: "S12345678",
      owners: [
        { name: "Owner One" },
        { name: "Owner Two", city: "LA", state: "CA" },
        { name: "Owner Three" },
      ],
    };

    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.owners).toHaveLength(3);
    }
  });

  it("rejects owner missing name", () => {
    const data = {
      decal_number: "LAA12345",
      serial_number: "S12345678",
      owners: [{ mailing_address: "123 Main St" }],
    };

    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects non-string decal_number", () => {
    const data = {
      decal_number: 12345,
      serial_number: "S12345678",
      owners: [{ name: "Jane Doe" }],
    };
    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("accepts whitespace-padded strings (LLM output quirk)", () => {
    const data = {
      decal_number: "  LAA12345  ",
      serial_number: " S12345678 ",
      owners: [{ name: " John Doe " }],
    };
    // Schema allows any string — trimming is a display concern
    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("rejects null at top level", () => {
    const result = ExtractedFieldsSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects array at top level", () => {
    const result = ExtractedFieldsSchema.safeParse([]);
    expect(result.success).toBe(false);
  });

  it("allows special characters in serial_number (real-world HCD data)", () => {
    const data = {
      decal_number: "LAA-12345",
      serial_number: "CAFL-S/N:12345-AB",
      owners: [{ name: "O'Brien & Associates" }],
    };
    const result = ExtractedFieldsSchema.safeParse(data);
    expect(result.success).toBe(true);
  });
});
