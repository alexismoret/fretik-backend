export default {
  // ============================================================================
  // Generic (minimal industry-neutral)
  // ============================================================================
  default: {
    name: "Général",
    description:
      "Ensemble minimal de champs qui conviennent à toute entreprise. Un bon point de départ si votre secteur d'activité n'est pas listé.",
    fields: {
      documentType: {
        label: "Type de document",
        description: "Catégorie fonctionnelle générique du document.",
        options: {
          invoice: "Facture",
          contract: "Contrat",
          report: "Rapport",
          letter: "Lettre",
          form: "Formulaire",
          receipt: "Reçu",
          other: "Autre",
        },
      },
      documentDate: {
        label: "Date du document",
        description:
          "Date imprimée sur le document, au format ISO 8601. Laissez vide si aucune date n'est explicitement présente.",
      },
    },
  },

  // ============================================================================
  // Transport & Logistics (the freight-locked experience pre-refactor)
  // ============================================================================
  transport: {
    name: "Transport et logistique",
    description:
      "Configuration axée sur le fret : type de document, mode de transport et classification des documents de fret. Idéal pour les transitaires, les transporteurs et les équipes logistiques.",
    fields: {
      documentType: {
        label: "Type de document",
        description:
          "Catégorie fonctionnelle générique du document. Choisissez la valeur la plus appropriée. Distinctions clés : order = demandes de biens/services (bons de commande, ordres de transport, demandes d'enlèvement, demandes de réservation) ; instruction = directives procédurales (instructions d'expédition, manuels) ; form = modèles structurés ; record = documentation officielle d'événements (connaissements, reçus, journaux) ; declaration = déclarations formelles aux autorités ; certificate = attestations officielles. Utilisez 'Inconnu' uniquement si le document ne peut pas être classé avec certitude. Ne placez jamais de valeur spécifique au transport ici — utilisez le champ Type de document de transport pour cela.",
        options: {
          invoice: "Facture",
          credit_note: "Avoir",
          receipt: "Reçu",
          statement: "Relevé",
          contract: "Contrat",
          order: "Commande",
          quotation: "Devis",
          certificate: "Certificat",
          permit: "Autorisation",
          declaration: "Déclaration",
          report: "Rapport",
          letter: "Lettre",
          form: "Formulaire",
          list: "Liste",
          instruction: "Instruction",
          specification: "Spécification",
          plan: "Plan",
          notice: "Avis",
          record: "Enregistrement",
          unknown: "Inconnu",
        },
      },
      transportMode: {
        label: "Mode de transport",
        description:
          "Mode de transport de l'expédition décrite. À renseigner lorsqu'il est explicitement mentionné ou clairement identifiable d'après le type de document (CMR → route ; lettre de transport aérien → air ; connaissement maritime → mer). Laissez vide en cas de doute ou si non applicable.",
        options: {
          sea: "Mer",
          air: "Air",
          road: "Route",
          rail: "Rail",
          inland_waterway: "Voie navigable intérieure",
          multimodal: "Multimodal",
        },
      },
      transportType: {
        label: "Type de document de transport",
        description:
          "Type de document de fret/logistique spécifique. À renseigner uniquement si le document est clairement lié au fret/à la logistique ; sinon, laissez vide. Choisissez la catégorie correspondant à la fonction principale du document : bill_of_lading pour tous les types de connaissement ; air_waybill pour les types de LTA ; road_consignment_note pour la CMR et le transport routier ; booking_document pour les demandes/confirmations de réservation ; transport_order pour les demandes d'enlèvement, les ordres de collecte, les instructions de transit ; delivery_document pour les bons de livraison, les preuves de livraison, les reçus de marchandises ; certificate_of_origin pour EUR1/ATR/Form A ; health_certificate pour les certificats phytosanitaires/vétérinaires/sanitaires ; inspection_certificate pour la qualité/quantité/poids/inspection ; customs_declaration pour import/export/transit/DAU ; freight_invoice pour les factures de fret et les notes de débit/crédit de transport.",
        options: {
          bill_of_lading: "Connaissement",
          sea_waybill: "Lettre de transport maritime",
          air_waybill: "Lettre de transport aérien (LTA)",
          road_consignment_note: "Lettre de voiture (CMR)",
          rail_consignment_note: "Lettre de voiture ferroviaire (CIM)",
          inland_waterway_bill: "Lettre de voiture fluviale",
          multimodal_transport_document: "Document de transport multimodal",
          charter_party: "Charte-partie",
          booking_document: "Document de réservation",
          shipping_instruction: "Instruction d'expédition",
          transport_order: "Ordre de transport",
          rate_document: "Document tarifaire",
          schedule: "Horaire",
          delivery_document: "Document de livraison",
          arrival_notice: "Avis d'arrivée",
          release_order: "Ordre de mainlevée",
          packing_list: "Liste de colisage",
          loading_list: "Liste de chargement",
          cargo_manifest: "Manifeste de cargaison",
          container_list: "Liste de conteneurs",
          customs_declaration: "Déclaration en douane",
          summary_declaration: "Déclaration sommaire",
          temporary_import_document: "Document d'importation temporaire",
          certificate_of_origin: "Certificat d'origine",
          customs_valuation_document: "Document de valeur en douane",
          export_license: "Licence d'exportation",
          health_certificate: "Certificat sanitaire",
          inspection_certificate: "Certificat d'inspection",
          fumigation_certificate: "Certificat de fumigation",
          damage_report: "Rapport d'avarie",
          vgm_declaration: "Déclaration VGM",
          dangerous_goods_declaration:
            "Déclaration de marchandises dangereuses",
          msds: "Fiche de données de sécurité (FDS)",
          cargo_insurance_certificate: "Certificat d'assurance cargaison",
          insurance_declaration: "Déclaration d'assurance",
          freight_invoice: "Facture de fret",
          customs_invoice: "Facture douanière",
          commercial_invoice_transport: "Facture commerciale (Transport)",
          container_interchange_document: "Document d'échange de conteneur",
          equipment_release: "Mise à disposition d'équipement",
          warehouse_receipt: "Récépissé d'entrepôt",
          storage_document: "Document de stockage",
          letter_of_credit: "Lettre de crédit",
          guarantee_document: "Document de garantie",
          tracking_report: "Rapport de suivi",
          special_instruction: "Instruction spéciale",
        },
      },
      documentDate: {
        label: "Date du document",
        description:
          "Date imprimée sur le document, au format ISO 8601. Laissez vide si aucune date n'est explicitement présente.",
      },
      documentNumber: {
        label: "Numéro de document",
        description:
          "Numéro officiel de document/référence/suivi lorsqu'il est présent (numéro de facture, numéro de connaissement, référence de réservation, …). Jusqu'à 100 caractères. Laissez vide s'il n'est pas présent.",
      },
    },
  },

  // ============================================================================
  // Legal / Contracts
  // ============================================================================
  legal: {
    name: "Juridique et contrats",
    description:
      "Conçu pour les équipes juridiques : métadonnées de contrat, parties, juridictions et dates clés. Idéal pour les juristes d'entreprise, les cabinets d'avocats et les équipes de conformité.",
    fields: {
      documentType: {
        label: "Type de document",
        description:
          "Type de document juridique. Choisissez la correspondance la plus spécifique. Utilisez 'Autre' uniquement lorsqu'aucun des types listés ne convient.",
        options: {
          nda: "Accord de confidentialité (NDA)",
          employment_contract: "Contrat de travail",
          service_agreement: "Contrat de prestation de services",
          consulting_agreement: "Contrat de conseil",
          lease: "Bail",
          amendment: "Avenant",
          power_of_attorney: "Procuration",
          settlement_agreement: "Accord transactionnel",
          terms_and_conditions: "Conditions générales",
          court_filing: "Acte de procédure",
          opinion_letter: "Consultation juridique",
          other: "Autre",
        },
      },
      effectiveDate: {
        label: "Date d'entrée en vigueur",
        description:
          "Date à laquelle l'accord prend légalement effet. Souvent intitulée 'Date d'entrée en vigueur', 'Date de prise d'effet' ou 'Date de début'. Laissez vide si elle n'est pas indiquée.",
      },
      expirationDate: {
        label: "Date d'expiration",
        description:
          "Date à laquelle l'accord se termine ou prend fin. Souvent intitulée 'Date d'expiration', 'Date de fin' ou 'Date de résiliation'. Laissez vide pour les accords à reconduction tacite sans date de fin.",
      },
      contractValue: {
        label: "Valeur du contrat",
        description:
          "Valeur monétaire totale du contrat dans la devise du document, sous forme de nombre (par ex. 250000 pour 250 000 €). Laissez vide si elle n'est pas indiquée.",
      },
      currency: {
        label: "Devise",
        description:
          "Devise de la valeur du contrat sous forme de code ISO 4217 à 3 lettres (EUR, USD, GBP, CHF, JPY, …). Laissez vide si aucune valeur monétaire n'est indiquée.",
        options: {
          EUR: "Euro (EUR)",
          USD: "Dollar américain (USD)",
          GBP: "Livre sterling (GBP)",
          CHF: "Franc suisse (CHF)",
          JPY: "Yen japonais (JPY)",
          CNY: "Yuan chinois (CNY)",
          CAD: "Dollar canadien (CAD)",
          AUD: "Dollar australien (AUD)",
        },
      },
      jurisdiction: {
        label: "Juridiction compétente",
        description:
          "Pays ou État dont les lois régissent l'accord, tel qu'indiqué dans la clause 'Droit applicable' (par ex. 'Angleterre et Pays de Galles', 'État du Delaware', 'France'). Laissez vide si aucune clause n'est présente.",
      },
      parties: {
        label: "Parties",
        description:
          "Noms de toutes les parties signataires tels qu'imprimés sur l'accord. La sélection multiple prend en charge un nombre illimité de parties. Laissez vide si non identifiable.",
      },
      counterpartyType: {
        label: "Type de contrepartie",
        description:
          "Nature de la contrepartie : entreprise, particulier, secteur public ou organisme à but non lucratif. Choisissez la valeur qui correspond le mieux à l'entité signataire en face de votre organisation.",
        options: {
          corporate: "Entreprise",
          individual: "Particulier",
          public_sector: "Secteur public",
          non_profit: "Organisme à but non lucratif",
          unknown: "Inconnu",
        },
      },
    },
  },

  // ============================================================================
  // Accounting / Finance
  // ============================================================================
  accounting: {
    name: "Comptabilité et finance",
    description:
      "Optimisé pour les équipes financières : métadonnées de facture, montants, devises, dates d'échéance et conditions de paiement. Idéal pour les comptes fournisseurs/clients, la tenue de comptes et les opérations financières.",
    fields: {
      documentType: {
        label: "Type de document",
        description:
          "Type de document comptable. Choisissez la correspondance la plus spécifique. 'Relevé' couvre les relevés bancaires et les relevés de compte ; 'Bon de commande' couvre les documents de commande émis par l'acheteur.",
        options: {
          invoice: "Facture",
          credit_note: "Avoir",
          debit_note: "Note de débit",
          receipt: "Reçu",
          statement: "Relevé",
          quote: "Devis",
          purchase_order: "Bon de commande",
          remittance_advice: "Avis de règlement",
          expense_report: "Note de frais",
          payslip: "Bulletin de paie",
          other: "Autre",
        },
      },
      invoiceNumber: {
        label: "Numéro de facture",
        description:
          "Numéro de facture ou de référence du document tel qu'imprimé (par ex. 'INV-2026-0123'). Laissez vide s'il n'est pas présent.",
      },
      invoiceDate: {
        label: "Date de facture",
        description:
          "Date d'émission de la facture, au format ISO 8601. Distincte de la date d'échéance.",
      },
      dueDate: {
        label: "Date d'échéance",
        description:
          "Date d'échéance du paiement au format ISO 8601. Laissez vide lorsque le document n'indique pas de date d'échéance.",
      },
      currency: {
        label: "Devise",
        description:
          "Devise des montants facturés sous forme de code ISO 4217 à 3 lettres (EUR, USD, GBP, CHF, …).",
        options: {
          EUR: "Euro (EUR)",
          USD: "Dollar américain (USD)",
          GBP: "Livre sterling (GBP)",
          CHF: "Franc suisse (CHF)",
          JPY: "Yen japonais (JPY)",
          CNY: "Yuan chinois (CNY)",
          CAD: "Dollar canadien (CAD)",
          AUD: "Dollar australien (AUD)",
        },
      },
      totalAmount: {
        label: "Montant total",
        description:
          "Montant total dû sur le document, dans la devise indiquée, sous forme de nombre (par ex. 1234.56). Inclut les taxes lorsque 'Taxes comprises' est vrai. Laissez vide si non indiqué.",
      },
      subtotalAmount: {
        label: "Sous-total (hors taxes)",
        description:
          "Sous-total hors taxes, dans la devise indiquée, sous forme de nombre. Laissez vide si le document ne le détaille pas.",
      },
      taxAmount: {
        label: "Montant des taxes",
        description:
          "Montant total des taxes sur le document (TVA, GST, taxe de vente, …), dans la devise indiquée, sous forme de nombre. Laissez vide si non indiqué.",
      },
      vatRate: {
        label: "Taux de TVA/taxe",
        description:
          "Taux de taxe applicable en pourcentage (par ex. 20 pour 20 %). Laissez vide lorsque plusieurs taux s'appliquent ou qu'aucun n'est indiqué.",
      },
      paymentTerms: {
        label: "Conditions de paiement",
        description:
          "Conditions de paiement telles qu'imprimées (par ex. 'Net 30', 'Payable à réception', '50 % d'acompte, 50 % à la livraison'). Laissez vide si non indiqué.",
      },
      vendorTaxId: {
        label: "Numéro fiscal du fournisseur",
        description:
          "Numéro d'identification fiscale du fournisseur/émetteur (numéro de TVA, EIN, SIREN, …) tel qu'imprimé. Laissez vide s'il n'est pas présent.",
      },
    },
  },
};
