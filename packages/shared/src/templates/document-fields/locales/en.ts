export default {
  // ============================================================================
  // Generic (minimal industry-neutral)
  // ============================================================================
  default: {
    name: "General",
    description:
      "Minimal set of fields that work for any business. A good starting point if your industry isn't listed.",
    fields: {
      documentType: {
        label: "Document type",
        description: "Generic functional category of the document.",
        options: {
          invoice: "Invoice",
          contract: "Contract",
          report: "Report",
          letter: "Letter",
          form: "Form",
          receipt: "Receipt",
          other: "Other",
        },
      },
      documentDate: {
        label: "Document date",
        description:
          "Date printed on the document, in ISO 8601 format. Leave empty if no date is explicitly present.",
      },
    },
  },

  // ============================================================================
  // Transport & Logistics (the freight-locked experience pre-refactor)
  // ============================================================================
  transport: {
    name: "Transport & Logistics",
    description:
      "Freight-focused setup: document type, transport mode and freight document classification. Ideal for forwarders, carriers and logistics teams.",
    fields: {
      documentType: {
        label: "Document type",
        description:
          "Generic functional document category. Pick the most appropriate value. Key distinctions: order = requests for goods/services (purchase orders, transport orders, pickup requests, booking requests); instruction = procedural directives (shipping instructions, manuals); form = structured templates; record = official documentation of events (bills of lading, receipts, logs); declaration = formal statements to authorities; certificate = official attestations. Use 'Unknown' only if the document cannot be confidently classified. Never put a transport-specific value here — use the Transport document type field for that.",
        options: {
          invoice: "Invoice",
          credit_note: "Credit note",
          receipt: "Receipt",
          statement: "Statement",
          contract: "Contract",
          order: "Order",
          quotation: "Quotation",
          certificate: "Certificate",
          permit: "Permit",
          declaration: "Declaration",
          report: "Report",
          letter: "Letter",
          form: "Form",
          list: "List",
          instruction: "Instruction",
          specification: "Specification",
          plan: "Plan",
          notice: "Notice",
          record: "Record",
          unknown: "Unknown",
        },
      },
      transportMode: {
        label: "Transport mode",
        description:
          "Mode of transport for the shipment described. Set when explicitly mentioned or clearly identifiable from the document type (CMR → road; Air Waybill → air; Ocean BL → sea). Leave empty if uncertain or not applicable.",
        options: {
          sea: "Sea",
          air: "Air",
          road: "Road",
          rail: "Rail",
          inland_waterway: "Inland waterway",
          multimodal: "Multimodal",
        },
      },
      transportType: {
        label: "Transport document type",
        description:
          "Specific freight/logistics document type. Set only if the document is clearly freight/logistics-related; otherwise leave empty. Pick the category matching the document's primary function: bill_of_lading for all BL types; air_waybill for AWB types; road_consignment_note for CMR and road transport; booking_document for booking requests/confirmations; transport_order for pickup requests, collection orders, forwarding instructions; delivery_document for delivery notes, proof of delivery, goods receipts; certificate_of_origin for EUR1/ATR/Form A; health_certificate for phytosanitary/veterinary/health; inspection_certificate for quality/quantity/weight/survey; customs_declaration for import/export/transit/SAD; freight_invoice for freight invoices and transport debit/credit notes.",
        options: {
          bill_of_lading: "Bill of Lading",
          sea_waybill: "Sea Waybill",
          air_waybill: "Air Waybill",
          road_consignment_note: "Road Consignment Note (CMR)",
          rail_consignment_note: "Rail Consignment Note (CIM)",
          inland_waterway_bill: "Inland Waterway Bill",
          multimodal_transport_document: "Multimodal Transport Document",
          charter_party: "Charter Party",
          booking_document: "Booking Document",
          shipping_instruction: "Shipping Instruction",
          transport_order: "Transport Order",
          rate_document: "Rate Document",
          schedule: "Schedule",
          delivery_document: "Delivery Document",
          arrival_notice: "Arrival Notice",
          release_order: "Release Order",
          packing_list: "Packing List",
          loading_list: "Loading List",
          cargo_manifest: "Cargo Manifest",
          container_list: "Container List",
          customs_declaration: "Customs Declaration",
          summary_declaration: "Summary Declaration",
          temporary_import_document: "Temporary Import Document",
          certificate_of_origin: "Certificate of Origin",
          customs_valuation_document: "Customs Valuation Document",
          export_license: "Export License",
          health_certificate: "Health Certificate",
          inspection_certificate: "Inspection Certificate",
          fumigation_certificate: "Fumigation Certificate",
          damage_report: "Damage Report",
          vgm_declaration: "VGM Declaration",
          dangerous_goods_declaration: "Dangerous Goods Declaration",
          msds: "Material Safety Data Sheet (MSDS)",
          cargo_insurance_certificate: "Cargo Insurance Certificate",
          insurance_declaration: "Insurance Declaration",
          freight_invoice: "Freight Invoice",
          customs_invoice: "Customs Invoice",
          commercial_invoice_transport: "Commercial Invoice (Transport)",
          container_interchange_document: "Container Interchange Document",
          equipment_release: "Equipment Release",
          warehouse_receipt: "Warehouse Receipt",
          storage_document: "Storage Document",
          letter_of_credit: "Letter of Credit",
          guarantee_document: "Guarantee Document",
          tracking_report: "Tracking Report",
          special_instruction: "Special Instruction",
        },
      },
      documentDate: {
        label: "Document date",
        description:
          "Date printed on the document, in ISO 8601 format. Leave empty if no date is explicitly present.",
      },
      documentNumber: {
        label: "Document number",
        description:
          "Official document/reference/tracking number when present (invoice number, BL number, booking reference, …). Up to 100 characters. Leave empty if not present.",
      },
    },
  },

  // ============================================================================
  // Legal / Contracts
  // ============================================================================
  legal: {
    name: "Legal & Contracts",
    description:
      "Tailored for legal teams: contract metadata, parties, jurisdictions and key dates. Ideal for in-house counsel, law firms and compliance teams.",
    fields: {
      documentType: {
        label: "Document type",
        description:
          "Type of legal document. Pick the most specific match. Use 'Other' only when none of the listed types fits.",
        options: {
          nda: "Non-disclosure agreement (NDA)",
          employment_contract: "Employment contract",
          service_agreement: "Service agreement",
          consulting_agreement: "Consulting agreement",
          lease: "Lease",
          amendment: "Amendment",
          power_of_attorney: "Power of attorney",
          settlement_agreement: "Settlement agreement",
          terms_and_conditions: "Terms & conditions",
          court_filing: "Court filing",
          opinion_letter: "Opinion letter",
          other: "Other",
        },
      },
      effectiveDate: {
        label: "Effective date",
        description:
          "Date on which the agreement becomes legally effective. Often labelled 'Effective date', 'Commencement date' or 'Start date'. Leave empty if not stated.",
      },
      expirationDate: {
        label: "Expiration date",
        description:
          "Date on which the agreement ends or terminates. Often labelled 'Expiration date', 'End date' or 'Termination date'. Leave empty for evergreen agreements with no end date.",
      },
      contractValue: {
        label: "Contract value",
        description:
          "Total monetary value of the contract in the document's currency, as a number (e.g. 250000 for €250,000). Leave empty if not stated.",
      },
      currency: {
        label: "Currency",
        description:
          "Currency of the contract value as a 3-letter ISO 4217 code (EUR, USD, GBP, CHF, JPY, …). Leave empty if no monetary value is stated.",
        options: {
          EUR: "Euro (EUR)",
          USD: "US Dollar (USD)",
          GBP: "British Pound (GBP)",
          CHF: "Swiss Franc (CHF)",
          JPY: "Japanese Yen (JPY)",
          CNY: "Chinese Yuan (CNY)",
          CAD: "Canadian Dollar (CAD)",
          AUD: "Australian Dollar (AUD)",
        },
      },
      jurisdiction: {
        label: "Governing jurisdiction",
        description:
          "Country or state whose laws govern the agreement, as printed in the 'Governing law' clause (e.g. 'England and Wales', 'State of Delaware', 'France'). Leave empty if no clause is present.",
      },
      parties: {
        label: "Parties",
        description:
          "Names of all signing parties as printed on the agreement. Multi-select supports any number of parties. Leave empty if not identifiable.",
      },
      counterpartyType: {
        label: "Counterparty type",
        description:
          "Nature of the counterparty: corporate, individual, public sector, or non-profit. Pick the value that best matches the entity signing across from your organization.",
        options: {
          corporate: "Corporate",
          individual: "Individual",
          public_sector: "Public sector",
          non_profit: "Non-profit",
          unknown: "Unknown",
        },
      },
    },
  },

  // ============================================================================
  // Accounting / Finance
  // ============================================================================
  accounting: {
    name: "Accounting & Finance",
    description:
      "Optimised for finance teams: invoice metadata, amounts, currencies, due dates and payment terms. Ideal for AP/AR, bookkeeping and finance ops.",
    fields: {
      documentType: {
        label: "Document type",
        description:
          "Type of accounting document. Pick the most specific match. 'Statement' covers bank statements and account statements; 'Purchase order' covers PO documents issued by the buyer.",
        options: {
          invoice: "Invoice",
          credit_note: "Credit note",
          debit_note: "Debit note",
          receipt: "Receipt",
          statement: "Statement",
          quote: "Quote",
          purchase_order: "Purchase order",
          remittance_advice: "Remittance advice",
          expense_report: "Expense report",
          payslip: "Payslip",
          other: "Other",
        },
      },
      invoiceNumber: {
        label: "Invoice number",
        description:
          "Invoice or document reference number as printed (e.g. 'INV-2026-0123'). Leave empty if not present.",
      },
      invoiceDate: {
        label: "Invoice date",
        description:
          "Date the invoice was issued, in ISO 8601 format. Distinct from the due date.",
      },
      dueDate: {
        label: "Due date",
        description:
          "Payment due date in ISO 8601 format. Leave empty when the document does not state a due date.",
      },
      currency: {
        label: "Currency",
        description:
          "Currency of the invoiced amounts as a 3-letter ISO 4217 code (EUR, USD, GBP, CHF, …).",
        options: {
          EUR: "Euro (EUR)",
          USD: "US Dollar (USD)",
          GBP: "British Pound (GBP)",
          CHF: "Swiss Franc (CHF)",
          JPY: "Japanese Yen (JPY)",
          CNY: "Chinese Yuan (CNY)",
          CAD: "Canadian Dollar (CAD)",
          AUD: "Australian Dollar (AUD)",
        },
      },
      totalAmount: {
        label: "Total amount",
        description:
          "Total amount due on the document, in the listed currency, as a number (e.g. 1234.56). Includes taxes when 'Tax inclusive' is true. Leave empty if not stated.",
      },
      subtotalAmount: {
        label: "Subtotal (pre-tax)",
        description:
          "Subtotal before tax, in the listed currency, as a number. Leave empty if the document does not break it out.",
      },
      taxAmount: {
        label: "Tax amount",
        description:
          "Total tax amount on the document (VAT, GST, sales tax, …), in the listed currency, as a number. Leave empty if not stated.",
      },
      vatRate: {
        label: "VAT/Tax rate",
        description:
          "Applicable tax rate as a percentage (e.g. 20 for 20%). Leave empty when multiple rates apply or none is stated.",
      },
      paymentTerms: {
        label: "Payment terms",
        description:
          "Payment terms as printed (e.g. 'Net 30', 'Due on receipt', '50% advance, 50% on delivery'). Leave empty if not stated.",
      },
      vendorTaxId: {
        label: "Vendor tax ID",
        description:
          "Tax identification number of the vendor/issuer (VAT number, EIN, SIREN, …) as printed. Leave empty if not present.",
      },
    },
  },
};
