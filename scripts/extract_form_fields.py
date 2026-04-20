"""
extract_form_fields.py — Direct PyMuPDF extraction of AcroForm fields.

Usage:
    python3 scripts/extract_form_fields.py <pdf_path>

Output:
    JSON array to stdout: [{ "name": "...", "type": "...", "page": N, "rect": [...], "value": "..." }]

Dependencies:
    pymupdf (installed via mcp-pdf[forms] or pymupdf4llm-mcp)
"""

import json
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    # Attempt import from pymupdf package name
    try:
        import pymupdf as fitz  # type: ignore
    except ImportError:
        print("ERROR: PyMuPDF (fitz) not available", file=sys.stderr)
        sys.exit(1)


def extract_fields(pdf_path: str) -> list[dict]:
    """Extract all AcroForm widget fields from a PDF."""
    doc = fitz.open(pdf_path)
    fields: list[dict] = []

    for page_num in range(len(doc)):
        page = doc[page_num]
        widgets = page.widgets()
        if widgets is None:
            continue

        for widget in widgets:
            field_type_map = {
                fitz.PDF_WIDGET_TYPE_TEXT: "text",
                fitz.PDF_WIDGET_TYPE_CHECKBOX: "checkbox",
                fitz.PDF_WIDGET_TYPE_RADIOBUTTON: "radio",
                fitz.PDF_WIDGET_TYPE_LISTBOX: "listbox",
                fitz.PDF_WIDGET_TYPE_COMBOBOX: "combobox",
                fitz.PDF_WIDGET_TYPE_BUTTON: "button",
                fitz.PDF_WIDGET_TYPE_SIGNATURE: "signature",
            }

            field_type = field_type_map.get(widget.field_type, f"unknown({widget.field_type})")
            rect = list(widget.rect) if widget.rect else None

            fields.append({
                "name": widget.field_name or f"unnamed_page{page_num}_{len(fields)}",
                "type": field_type,
                "page": page_num,
                "rect": rect,
                "value": widget.field_value or None,
            })

    doc.close()
    return fields


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <pdf_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not Path(pdf_path).exists():
        print(f"ERROR: File not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    fields = extract_fields(pdf_path)
    print(json.dumps(fields, indent=2))


if __name__ == "__main__":
    main()
