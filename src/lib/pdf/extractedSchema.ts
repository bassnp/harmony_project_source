/**
 * extractedSchema — Zod schema for fields extracted from an HCD title PDF.
 *
 * Defines the exact JSON shape the extractor stage must produce.
 * The approved version of this data is then used by the filler stage
 * to populate the three blank HCD forms.
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Schema for a single owner entry extracted from the title.
 * Supports up to 3 owners (HCD 480.5 has 3 owner slots).
 */
const OwnerSchema = z.object({
  name: z.string().describe("Full legal name of the owner"),
  mailing_address: z.string().optional().describe("Street address"),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
});

/**
 * Schema for the complete set of fields extracted from an HCD title PDF.
 * This is the contract between the extractor Copilot stage and the
 * HITL approval step.
 */
export const ExtractedFieldsSchema = z.object({
  /** HCD decal/sticker number. */
  decal_number: z.string().describe("HCD decal number from the title"),
  /** Serial/identification number of the manufactured home. */
  serial_number: z.string().describe("Serial number of the unit"),
  /** Manufacturer trade name (e.g., 'Fleetwood', 'Skyline'). */
  trade_name: z.string().optional().describe("Manufacturer trade name"),
  /** Manufacturer name. */
  manufacturer_name: z.string().optional(),
  /** Year/date of manufacture. */
  manufacture_date: z.string().optional(),
  /** Model name/number. */
  model_name: z.string().optional(),
  /** List of owners extracted from the title. */
  owners: z.array(OwnerSchema).min(1).describe("At least one owner required"),
  /** Situs (physical location) address of the unit. */
  situs_address: z.string().optional(),
  situs_city: z.string().optional(),
  situs_state: z.string().optional(),
  situs_zip: z.string().optional(),
  /** Sale/transfer price. */
  sale_price: z.string().optional(),
  /** Date of sale/transfer. */
  sale_date: z.string().optional(),
  /** Any additional notes or context from the title. */
  notes: z.string().optional(),
});

export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;
export type Owner = z.infer<typeof OwnerSchema>;
