/**
 * French translations for external-app approval summaries.
 *
 * Translation keys map 1:1 to the structural fields stored in
 * `tool_approval_requests.summary` (titleKey, titleParams, labelKey).
 *
 * Add a new language by mirroring this file as `<lang>.ts` and registering
 * it in `../index.ts`.
 */
export default {
  external_apps: {
    approvals: {
      plan: {
        title: {
          default: "Plan : {{count}} action(s)",
        },
      },

      fields: {
        to: "À",
        cc: "Cc",
        bcc: "Cci",
        subject: "Objet",
        body: "Corps",
        attachments: "Pièces jointes",
        inline_images: "Images intégrées",
        member_count: "Personnes",
        topic: "Sujet",
        message_id: "ID du message",
        event_id: "ID de l'événement",
        draft_id: "ID du brouillon",
        comment: "Commentaire",
        destination_folder: "Dossier de destination",
        parent_folder: "Dossier parent",
        display_name: "Nom",
        start: "Début",
        end: "Fin",
        time_zone: "Fuseau horaire",
        location: "Lieu",
        attendees: "Participants",
        online_meeting: "Réunion en ligne",
        response: "Réponse",
        new_subject: "Nouvel objet",
        new_body: "Nouveau corps",
        new_start: "Nouveau début",
        new_end: "Nouvelle fin",
        new_location: "Nouveau lieu",
        first_name: "Prénom",
        last_name: "Nom",
        email: "E-mail",
        company: "Entreprise",
        job_title: "Fonction",
        phone: "Téléphone",
        rule_id: "ID de la règle",
        new_display_name: "Nouveau nom",
        new_sequence: "Nouvelle séquence",
        new_is_enabled: "Nouvel état activé",
        sequence: "Séquence",
        is_enabled: "Activé",
        from_addresses: "De",
        subject_contains: "L'objet contient",
        body_contains: "Le corps contient",
        has_attachments: "Contient des pièces jointes",
        move_to_folder: "Déplacer vers le dossier",
        mark_as_read: "Marquer comme lu",
        auto_delete: "Suppression automatique",
        count: "Nombre",
        message_ids_preview: "Exemples d'ID",
        flag_status: "Statut du drapeau",
        due_date: "Date d'échéance",
        // Front-specific field labels.
        archive_after: "Archiver après envoi",
        tag_count: "Tags à ajouter",
        new_status: "Nouveau statut",
        scheduled_at: "Planifié jusqu'à",
        handles: "Coordonnées",
        description: "Description",
        is_spammer: "Spam",
        tag_name: "Nom du tag",
        highlight: "Couleur de surbrillance",
        // Shiptify-specific field labels.
        name: "Nom",
        reply_before: "Répondre avant",
        from_count: "Points d'enlèvement",
        dest_count: "Points de livraison",
        internal_ref: "Référence interne",
        internal_name: "Nom interne",
        attachment_count: "Pièces jointes",
        message: "Message",
        date: "Date",
        time: "Heure",
        incident: "Incident",
        reason: "Motif",
        address_1: "Adresse",
        address_2: "Adresse (ligne 2)",
        zipcode: "Code postal",
        city: "Ville",
        country: "Pays",
        recipient_name: "Destinataire",
        instructions: "Instructions",
        // Planner-specific field labels.
        title: "Titre",
        percent_complete: "Progression",
        assignees: "Personnes assignées",
        checklist: "Éléments de checklist",
      },

      values: {
        yes: "Oui",
        no: "Non",
      },

      outlook: {
        send_email: {
          title: { default: "Envoyer un e-mail à {{recipients}}" },
        },
        reply_email: {
          title: { default: "Répondre à l'e-mail" },
        },
        reply_all_email: {
          title: { default: "Répondre à tous à l'e-mail" },
        },
        forward_email: {
          title: { default: "Transférer l'e-mail à {{recipients}}" },
        },
        create_draft: {
          title: { default: "Créer un brouillon pour {{recipients}}" },
        },
        update_draft: {
          title: {
            default: "Mettre à jour le brouillon",
            withSubject: 'Mettre à jour le brouillon — "{{subject}}"',
          },
        },
        delete_message: {
          title: { default: "Supprimer l'e-mail" },
        },
        move_message: {
          title: { default: "Déplacer l'e-mail vers un dossier" },
        },
        copy_message: {
          title: { default: "Copier l'e-mail vers un dossier" },
        },
        mark_read: {
          title: { default: "Marquer l'e-mail comme lu" },
        },
        mark_unread: {
          title: { default: "Marquer l'e-mail comme non lu" },
        },
        flag_message: {
          title: {
            flagged: "Marquer l'e-mail pour suivi",
            complete: "Marquer l'e-mail comme terminé",
            notFlagged: "Retirer le drapeau de l'e-mail",
            default: "Mettre à jour le drapeau de l'e-mail",
          },
        },
        create_folder: {
          title: { default: 'Créer le dossier de messagerie "{{name}}"' },
        },
        create_calendar_event: {
          title: {
            default: 'Créer l\'événement "{{subject}}" ({{start}} → {{end}})',
          },
        },
        update_calendar_event: {
          title: {
            default: "Mettre à jour l'événement de calendrier",
            withSubject:
              'Mettre à jour l\'événement de calendrier — "{{subject}}"',
          },
        },
        delete_calendar_event: {
          title: { default: "Supprimer l'événement de calendrier" },
        },
        respond_to_event: {
          title: {
            accept: "Accepter l'invitation de calendrier",
            decline: "Refuser l'invitation de calendrier",
            tentativelyAccept:
              "Accepter provisoirement l'invitation de calendrier",
            default: "Répondre à l'invitation de calendrier",
          },
        },
        create_contact: {
          title: { default: 'Créer le contact "{{name}}"' },
        },
        create_inbox_rule: {
          title: { default: 'Créer la règle de boîte de réception "{{name}}"' },
        },
        update_inbox_rule: {
          title: {
            default: "Mettre à jour la règle de boîte de réception",
            withName:
              'Mettre à jour la règle de boîte de réception — "{{name}}"',
          },
        },
        delete_inbox_rule: {
          title: { default: "Supprimer la règle de boîte de réception" },
        },
        delete_messages: {
          title: { default: "Supprimer {{count}} e-mails" },
        },
        move_messages: {
          title: {
            default: "Déplacer {{count}} e-mails vers un autre dossier",
          },
        },
        mark_messages_read: {
          title: { default: "Marquer {{count}} e-mails comme lus" },
        },
        mark_messages_unread: {
          title: { default: "Marquer {{count}} e-mails comme non lus" },
        },
      },

      teams: {
        send_chat_message: {
          title: { default: "Envoyer un message Teams" },
        },
        create_chat: {
          title: {
            oneOnOne: "Démarrer une conversation Teams",
            group:
              "Démarrer une conversation de groupe Teams avec {{count}} personnes",
          },
        },
        send_channel_message: {
          title: { default: "Publier dans un canal Teams" },
        },
        reply_to_channel_message: {
          title: { default: "Répondre dans un fil Teams" },
        },
      },

      planner: {
        create_task: {
          title: { default: 'Créer la tâche "{{title}}"' },
        },
        update_task: {
          title: { default: "Mettre à jour la tâche" },
        },
        update_task_details: {
          title: { default: "Mettre à jour la description de la tâche" },
        },
        delete_task: {
          title: { default: "Supprimer la tâche" },
        },
        create_bucket: {
          title: { default: 'Créer le compartiment "{{name}}"' },
        },
        create_plan: {
          title: { default: 'Créer le plan "{{title}}"' },
        },
      },

      "imap-smtp": {
        send_email: {
          title: { default: "Envoyer un e-mail à {{recipients}}" },
        },
        reply_email: {
          title: { default: "Répondre à l'e-mail" },
        },
        forward_email: {
          title: { default: "Transférer l'e-mail à {{recipients}}" },
        },
        delete_message: {
          title: { default: "Supprimer l'e-mail" },
        },
        move_message: {
          title: { default: "Déplacer l'e-mail vers un dossier" },
        },
        mark_read: {
          title: { default: "Marquer l'e-mail comme lu" },
        },
        mark_unread: {
          title: { default: "Marquer l'e-mail comme non lu" },
        },
        create_folder: {
          title: { default: 'Créer le dossier de messagerie "{{name}}"' },
        },
        delete_messages: {
          title: { default: "Supprimer {{count}} e-mails" },
        },
        move_messages: {
          title: {
            default: "Déplacer {{count}} e-mails vers un autre dossier",
          },
        },
        mark_messages_read: {
          title: { default: "Marquer {{count}} e-mails comme lus" },
        },
        mark_messages_unread: {
          title: { default: "Marquer {{count}} e-mails comme non lus" },
        },
      },

      exchange: {
        send_email: {
          title: { default: "Envoyer un e-mail à {{recipients}}" },
        },
        reply_email: {
          title: { default: "Répondre à l'e-mail" },
        },
        reply_all_email: {
          title: { default: "Répondre à tous à l'e-mail" },
        },
        forward_email: {
          title: { default: "Transférer l'e-mail à {{recipients}}" },
        },
        create_draft: {
          title: { default: "Créer un brouillon d'e-mail" },
        },
        update_draft: {
          title: {
            default: "Mettre à jour le brouillon",
            withSubject: 'Mettre à jour le brouillon : "{{subject}}"',
          },
        },
        delete_message: {
          title: { default: "Supprimer l'e-mail" },
        },
        move_message: {
          title: { default: "Déplacer l'e-mail vers un dossier" },
        },
        copy_message: {
          title: { default: "Copier l'e-mail vers un dossier" },
        },
        delete_messages: {
          title: { default: "Supprimer {{count}} e-mails" },
        },
        move_messages: {
          title: {
            default: "Déplacer {{count}} e-mails vers un autre dossier",
          },
        },
        mark_messages_read: {
          title: { default: "Marquer {{count}} e-mails comme lus" },
        },
        mark_messages_unread: {
          title: { default: "Marquer {{count}} e-mails comme non lus" },
        },
        mark_read: {
          title: { default: "Marquer l'e-mail comme lu" },
        },
        mark_unread: {
          title: { default: "Marquer l'e-mail comme non lu" },
        },
        flag_message: {
          title: {
            flagged: "Marquer l'e-mail pour suivi",
            complete: "Marquer l'e-mail comme terminé",
            notFlagged: "Retirer le drapeau de l'e-mail",
            default: "Mettre à jour le drapeau de l'e-mail",
          },
        },
        create_folder: {
          title: { default: 'Créer le dossier de messagerie "{{name}}"' },
        },
        create_calendar_event: {
          title: { default: 'Créer l\'événement "{{subject}}"' },
        },
        update_calendar_event: {
          title: {
            default: "Mettre à jour l'événement de calendrier",
            withSubject: 'Mettre à jour l\'événement "{{subject}}"',
          },
        },
        delete_calendar_event: {
          title: { default: "Supprimer l'événement de calendrier" },
        },
        respond_to_event: {
          title: {
            accept: "Accepter l'invitation à la réunion",
            decline: "Refuser l'invitation à la réunion",
            tentativelyAccept:
              "Accepter provisoirement l'invitation à la réunion",
            default: "Répondre à l'invitation à la réunion",
          },
        },
        create_contact: {
          title: { default: 'Créer le contact "{{name}}"' },
        },
      },

      shiptify: {
        create_shipment_request: {
          title: { default: 'Créer la demande d\'expédition "{{name}}"' },
        },
        create_shipment_request_draft: {
          title: {
            default: 'Créer le brouillon de demande d\'expédition "{{name}}"',
          },
        },
        update_shipment_request: {
          title: { default: "Mettre à jour la demande d'expédition" },
        },
        cancel_shipment_request: {
          title: { default: "Annuler la demande d'expédition" },
        },
        upload_shipment_request_attachment: {
          title: {
            default:
              "Importer {{count}} fichier(s) dans la demande d'expédition",
          },
        },
        send_shipment_request_message: {
          title: {
            default:
              "Publier un message dans la messagerie de la demande d'expédition",
          },
        },
        confirm_shipment_pickup: {
          title: { default: "Confirmer l'enlèvement le {{date}}" },
        },
        confirm_shipment_delivery: {
          title: { default: "Confirmer la livraison le {{date}}" },
        },
        replan_shipment_pickup: {
          title: { default: "Replanifier l'enlèvement au {{date}}" },
        },
        replan_shipment_delivery: {
          title: { default: "Replanifier la livraison au {{date}}" },
        },
        upload_shipment_attachment: {
          title: { default: "Importer {{count}} fichier(s) dans l'expédition" },
        },
        send_shipment_message: {
          title: {
            default:
              "Publier un message dans la messagerie de suivi d'expédition",
          },
        },
        create_location: {
          title: { default: 'Créer le lieu "{{name}}"' },
        },
        // Galaxy (carrier-side) — same wording as the shipper variants
        // when the underlying intent matches, prefixed with "Carrier:"
        // so the user can tell the approval card apart at a glance.
        galaxy_create_carrier_shipment_request: {
          title: {
            default: 'Transporteur : créer la demande d\'expédition "{{name}}"',
          },
        },
        galaxy_create_carrier_shipment_request_draft: {
          title: {
            default:
              'Transporteur : créer le brouillon de demande d\'expédition "{{name}}"',
          },
        },
        galaxy_upload_shipment_request_attachment: {
          title: {
            default:
              "Transporteur : importer {{count}} fichier(s) dans la demande d'expédition",
          },
        },
        galaxy_send_shipment_request_message: {
          title: {
            default:
              "Transporteur : publier un message dans la messagerie de la demande d'expédition",
          },
        },
        galaxy_cancel_quote_request: {
          title: { default: "Transporteur : annuler la demande de devis" },
        },
        galaxy_confirm_shipment_pickup: {
          title: {
            default: "Transporteur : confirmer l'enlèvement le {{date}}",
          },
        },
        galaxy_confirm_shipment_delivery: {
          title: {
            default: "Transporteur : confirmer la livraison le {{date}}",
          },
        },
        galaxy_replan_shipment_pickup: {
          title: {
            default: "Transporteur : replanifier l'enlèvement au {{date}}",
          },
        },
        galaxy_replan_shipment_delivery: {
          title: {
            default: "Transporteur : replanifier la livraison au {{date}}",
          },
        },
        galaxy_confirm_shipment: {
          title: {
            default: "Transporteur : confirmer l'expédition le {{date}}",
          },
        },
        galaxy_cancel_shipment: {
          title: { default: "Transporteur : annuler l'expédition" },
        },
        galaxy_upload_shipment_attachment: {
          title: {
            default:
              "Transporteur : importer {{count}} fichier(s) dans l'expédition",
          },
        },
        galaxy_send_shipment_message: {
          title: {
            default:
              "Transporteur : publier un message dans la messagerie de suivi d'expédition",
          },
        },
        galaxy_confirm_tracking_point: {
          title: {
            default: "Transporteur : confirmer le point de suivi le {{date}}",
          },
        },
        galaxy_replan_tracking_point: {
          title: {
            default: "Transporteur : replanifier le point de suivi au {{date}}",
          },
        },
        galaxy_cancel_tracking_point: {
          title: { default: "Transporteur : annuler le point de suivi" },
        },
        galaxy_update_tracking_point_location: {
          title: {
            default:
              "Transporteur : déplacer le point de suivi vers une nouvelle adresse",
          },
        },
      },

      front: {
        reply_to_conversation: {
          title: { default: "Répondre à la conversation Front" },
        },
        send_new_message: {
          title: {
            default: "Envoyer un nouveau message Front à {{recipients}}",
          },
        },
        update_conversation: {
          title: {
            default: "Mettre à jour la conversation Front",
            archive: "Archiver la conversation Front",
            reopen: "Rouvrir la conversation Front",
            trash: "Mettre la conversation Front à la corbeille",
            spam: "Marquer la conversation Front comme spam",
            assign: "Attribuer la conversation Front",
            unassign: "Annuler l'attribution de la conversation Front",
            move: "Déplacer la conversation Front vers une autre boîte de réception",
          },
        },
        delete_conversation: {
          title: { default: "Supprimer la conversation Front" },
        },
        add_conversation_tags: {
          title: {
            default: "Ajouter {{count}} tag(s) à la conversation Front",
          },
        },
        remove_conversation_tags: {
          title: {
            default: "Retirer {{count}} tag(s) de la conversation Front",
          },
        },
        add_conversation_comment: {
          title: {
            default: "Ajouter une note interne à la conversation Front",
          },
        },
        snooze_conversation: {
          title: {
            default:
              "Mettre en veille la conversation Front jusqu'au {{until}}",
          },
        },
        unsnooze_conversation: {
          title: { default: "Réactiver la conversation Front" },
        },
        add_conversation_followers: {
          title: {
            default: "Ajouter {{count}} abonné(s) à la conversation Front",
          },
        },
        remove_conversation_followers: {
          title: {
            default: "Retirer {{count}} abonné(s) de la conversation Front",
          },
        },
        create_contact: {
          title: {
            default: "Créer le contact Front",
            withName: 'Créer le contact Front "{{name}}"',
          },
        },
        update_contact: {
          title: { default: "Mettre à jour le contact Front" },
        },
        create_tag: {
          title: { default: 'Créer le tag Front "{{name}}"' },
        },
        update_tag: {
          title: {
            default: "Mettre à jour le tag Front",
            withName: 'Renommer le tag Front en "{{name}}"',
          },
        },
        delete_tag: {
          title: { default: "Supprimer le tag Front" },
        },
      },
    },
  },
};
