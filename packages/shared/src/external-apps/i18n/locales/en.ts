/**
 * English translations for external-app approval summaries.
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
          default: "Plan: {{count}} action(s)",
        },
      },

      fields: {
        to: "To",
        cc: "Cc",
        bcc: "Bcc",
        subject: "Subject",
        body: "Body",
        attachments: "Attachments",
        inline_images: "Inline images",
        member_count: "People",
        topic: "Topic",
        message_id: "Message ID",
        event_id: "Event ID",
        draft_id: "Draft ID",
        comment: "Comment",
        destination_folder: "Destination folder",
        parent_folder: "Parent folder",
        display_name: "Name",
        start: "Start",
        end: "End",
        time_zone: "Time zone",
        location: "Location",
        attendees: "Attendees",
        online_meeting: "Online meeting",
        response: "Response",
        new_subject: "New subject",
        new_body: "New body",
        new_start: "New start",
        new_end: "New end",
        new_location: "New location",
        first_name: "First name",
        last_name: "Last name",
        email: "Email",
        company: "Company",
        job_title: "Job title",
        phone: "Phone",
        rule_id: "Rule ID",
        new_display_name: "New name",
        new_sequence: "New sequence",
        new_is_enabled: "New enabled",
        sequence: "Sequence",
        is_enabled: "Enabled",
        from_addresses: "From",
        subject_contains: "Subject contains",
        body_contains: "Body contains",
        has_attachments: "Has attachments",
        move_to_folder: "Move to folder",
        mark_as_read: "Mark as read",
        auto_delete: "Auto-delete",
        count: "Count",
        message_ids_preview: "Sample IDs",
        flag_status: "Flag status",
        due_date: "Due date",
        // Front-specific field labels.
        archive_after: "Archive after sending",
        tag_count: "Tags to add",
        new_status: "New status",
        scheduled_at: "Scheduled until",
        handles: "Handles",
        description: "Description",
        is_spammer: "Spam",
        tag_name: "Tag name",
        highlight: "Highlight color",
        // Shiptify-specific field labels.
        name: "Name",
        reply_before: "Reply before",
        from_count: "Pickup stops",
        dest_count: "Delivery stops",
        internal_ref: "Internal reference",
        internal_name: "Internal name",
        other_reference: "Other reference",
        code: "Stop code",
        attachment_count: "Attachments",
        message: "Message",
        date: "Date",
        time: "Time",
        incident: "Incident",
        reason: "Reason",
        address_1: "Address",
        address_2: "Address (line 2)",
        zipcode: "Zip code",
        city: "City",
        country: "Country",
        recipient_name: "Recipient",
        instructions: "Instructions",
        // Planner-specific field labels.
        title: "Title",
        percent_complete: "Progress",
        assignees: "Assignees",
        checklist: "Checklist items",
        // Akanea WMS-specific field labels.
        warehouse_customer: "Warehouse customer",
        suppliers: "Suppliers",
        consignees: "Consignees",
        line_count: "Lines",
        planned_receiving: "Planned receiving",
        planned_delivery: "Planned delivery",
        items: "Items",
        parties: "Parties",
        pallets: "Pallets",
        new_stock_status: "New stock status",
        new_stock_location: "New storage location",
        new_batch: "New batch",
        new_quantity: "New quantity (sale units)",
        new_expiry: "New expiry date",
        // Pbyp-specific field labels.
        collection: "Table",
        row_count: "Rows",
        reference: "Reference",
        ids: "Identifiers",
        number: "Number",
        module: "Module",
        incoterm: "Incoterm",
        shipper: "Shipper",
        consignee: "Consignee",
        client_reference: "Client reference",
        parcels: "Cargo lines",
        shared_with: "Shared with",
        comments: "Comments",
        folder_type: "Folder type",
        master_id: "Master folder",
        order_ids: "Orders",
        booking_number: "Booking number",
        ship_name: "Vessel",
        voyage_number: "Voyage number",
        BL_number: "BL number",
        LTA: "Air waybill",
        ETD: "ETD",
        ETA: "ETA",
        containers: "Containers",
        container_count: "Containers",
        flights: "Flights",
        validity_end_date: "Valid until",
        quotes: "Charge lines",
        target: "Target",
        event_type_id: "Event type",
        actual: "Actual",
        total_quantity: "Total quantity",
        order_id: "Order",
        folder_id: "Folder",
        object: "Object",
        object_id: "Object id",
        entity_id: "Entity",
        access: "Access",
        quotation_id: "Quotation",
        quotation_status: "Status",
        gateway_id: "Gateway",
        external_reference: "Partner reference",
        external_code: "Partner code",
        gateway_type: "Partner",
        scope: "Scope",
        target_id: "Target id",
        parcel_id: "Cargo line",
        profile_id: "Profile",
        booking_id: "Booking",
        first_awb: "First AWB",
        last_awb: "Last AWB",
        airline_company: "Airline",
        role_id: "Role",
        agency_id: "Agency",
        admin_email: "Administrator email",
        address: "Address",
        // SharePoint-specific field labels.
        file_name: "File",
        new_name: "New name",
        version: "Version",
        link_type: "Link permission",
        link_scope: "Who can use the link",
        expires_at: "Expires on",
        role: "Access level",
        values: "Values",
        new_values: "New values",
      },

      values: {
        yes: "Yes",
        no: "No",
      },

      outlook: {
        send_email: {
          title: { default: "Send email to {{recipients}}" },
        },
        reply_email: {
          title: { default: "Reply to email" },
        },
        reply_all_email: {
          title: { default: "Reply-all to email" },
        },
        forward_email: {
          title: { default: "Forward email to {{recipients}}" },
        },
        create_draft: {
          title: { default: "Create draft to {{recipients}}" },
        },
        update_draft: {
          title: {
            default: "Update draft",
            withSubject: 'Update draft — "{{subject}}"',
          },
        },
        delete_message: {
          title: { default: "Delete email" },
        },
        move_message: {
          title: { default: "Move email to folder" },
        },
        copy_message: {
          title: { default: "Copy email to folder" },
        },
        mark_read: {
          title: { default: "Mark email as read" },
        },
        mark_unread: {
          title: { default: "Mark email as unread" },
        },
        flag_message: {
          title: {
            flagged: "Flag email for follow-up",
            complete: "Mark email as complete",
            notFlagged: "Clear flag on email",
            default: "Update flag on email",
          },
        },
        create_folder: {
          title: { default: 'Create mail folder "{{name}}"' },
        },
        create_calendar_event: {
          title: {
            default: 'Create event "{{subject}}" ({{start}} → {{end}})',
          },
        },
        update_calendar_event: {
          title: {
            default: "Update calendar event",
            withSubject: 'Update calendar event — "{{subject}}"',
          },
        },
        delete_calendar_event: {
          title: { default: "Delete calendar event" },
        },
        respond_to_event: {
          title: {
            accept: "Accept calendar invite",
            decline: "Decline calendar invite",
            tentativelyAccept: "Tentatively accept calendar invite",
            default: "Respond to calendar invite",
          },
        },
        create_contact: {
          title: { default: 'Create contact "{{name}}"' },
        },
        create_inbox_rule: {
          title: { default: 'Create inbox rule "{{name}}"' },
        },
        update_inbox_rule: {
          title: {
            default: "Update inbox rule",
            withName: 'Update inbox rule — "{{name}}"',
          },
        },
        delete_inbox_rule: {
          title: { default: "Delete inbox rule" },
        },
        delete_messages: {
          title: { default: "Delete {{count}} emails" },
        },
        move_messages: {
          title: {
            default: "Move {{count}} emails to another folder",
          },
        },
        mark_messages_read: {
          title: { default: "Mark {{count}} emails as read" },
        },
        mark_messages_unread: {
          title: { default: "Mark {{count}} emails as unread" },
        },
      },

      teams: {
        send_chat_message: {
          title: { default: "Send Teams message" },
        },
        create_chat: {
          title: {
            oneOnOne: "Start a Teams chat",
            group: "Start a Teams group chat with {{count}} people",
          },
        },
        send_channel_message: {
          title: { default: "Post in Teams channel" },
        },
        reply_to_channel_message: {
          title: { default: "Reply in Teams thread" },
        },
      },

      planner: {
        create_task: {
          title: { default: 'Create task "{{title}}"' },
        },
        update_task: {
          title: { default: "Update task" },
        },
        update_task_details: {
          title: { default: "Update task description" },
        },
        delete_task: {
          title: { default: "Delete task" },
        },
        create_bucket: {
          title: { default: 'Create bucket "{{name}}"' },
        },
        create_plan: {
          title: { default: 'Create plan "{{title}}"' },
        },
      },

      sharepoint: {
        create_folder: {
          title: { default: 'Create SharePoint folder "{{name}}"' },
        },
        create_upload_session: {
          title: {
            default: 'Upload "{{name}}" to SharePoint',
            replace:
              'Upload "{{name}}" to SharePoint, replacing the existing file',
          },
        },
        update_item: {
          title: {
            default: "Rename or move a SharePoint file",
            rename: 'Rename a SharePoint file to "{{name}}"',
            move: "Move a SharePoint file to another folder",
            rename_move: 'Move a SharePoint file and rename it "{{name}}"',
          },
        },
        delete_item: {
          title: { default: "Delete a SharePoint file (to the recycle bin)" },
        },
        copy_item: {
          title: { default: "Copy a SharePoint file to another folder" },
        },
        restore_version: {
          title: {
            default: "Restore version {{version}} of a SharePoint file",
          },
        },
        create_share_link: {
          title: {
            default: "Create a SharePoint sharing link",
            anonymous:
              "Create a PUBLIC SharePoint link — anyone holding the URL can open it",
          },
        },
        grant_item_access: {
          title: { default: "Give {{recipients}} access to a SharePoint file" },
        },
        revoke_item_access: {
          title: { default: "Revoke access to a SharePoint file" },
        },
        create_list_item: {
          title: { default: "Add a row to a SharePoint list" },
        },
        update_list_item: {
          title: { default: "Update a SharePoint list row" },
        },
        delete_list_item: {
          title: { default: "Delete a SharePoint list row" },
        },
      },

      "imap-smtp": {
        send_email: {
          title: { default: "Send email to {{recipients}}" },
        },
        reply_email: {
          title: { default: "Reply to email" },
        },
        forward_email: {
          title: { default: "Forward email to {{recipients}}" },
        },
        delete_message: {
          title: { default: "Delete email" },
        },
        move_message: {
          title: { default: "Move email to folder" },
        },
        mark_read: {
          title: { default: "Mark email as read" },
        },
        mark_unread: {
          title: { default: "Mark email as unread" },
        },
        create_folder: {
          title: { default: 'Create mail folder "{{name}}"' },
        },
        delete_messages: {
          title: { default: "Delete {{count}} emails" },
        },
        move_messages: {
          title: {
            default: "Move {{count}} emails to another folder",
          },
        },
        mark_messages_read: {
          title: { default: "Mark {{count}} emails as read" },
        },
        mark_messages_unread: {
          title: { default: "Mark {{count}} emails as unread" },
        },
      },

      exchange: {
        send_email: {
          title: { default: "Send email to {{recipients}}" },
        },
        reply_email: {
          title: { default: "Reply to email" },
        },
        reply_all_email: {
          title: { default: "Reply all to email" },
        },
        forward_email: {
          title: { default: "Forward email to {{recipients}}" },
        },
        create_draft: {
          title: { default: "Create draft email" },
        },
        update_draft: {
          title: {
            default: "Update draft",
            withSubject: 'Update draft: "{{subject}}"',
          },
        },
        delete_message: {
          title: { default: "Delete email" },
        },
        move_message: {
          title: { default: "Move email to folder" },
        },
        copy_message: {
          title: { default: "Copy email to folder" },
        },
        delete_messages: {
          title: { default: "Delete {{count}} emails" },
        },
        move_messages: {
          title: { default: "Move {{count}} emails to another folder" },
        },
        mark_messages_read: {
          title: { default: "Mark {{count}} emails as read" },
        },
        mark_messages_unread: {
          title: { default: "Mark {{count}} emails as unread" },
        },
        mark_read: {
          title: { default: "Mark email as read" },
        },
        mark_unread: {
          title: { default: "Mark email as unread" },
        },
        flag_message: {
          title: {
            flagged: "Flag email for follow-up",
            complete: "Mark email as complete",
            notFlagged: "Clear email flag",
            default: "Update email flag",
          },
        },
        create_folder: {
          title: { default: 'Create mail folder "{{name}}"' },
        },
        create_calendar_event: {
          title: { default: 'Create event "{{subject}}"' },
        },
        update_calendar_event: {
          title: {
            default: "Update calendar event",
            withSubject: 'Update event "{{subject}}"',
          },
        },
        delete_calendar_event: {
          title: { default: "Delete calendar event" },
        },
        respond_to_event: {
          title: {
            accept: "Accept meeting invite",
            decline: "Decline meeting invite",
            tentativelyAccept: "Tentatively accept meeting invite",
            default: "Respond to meeting invite",
          },
        },
        create_contact: {
          title: { default: 'Create contact "{{name}}"' },
        },
      },

      pbyp: {
        create_items: {
          title: { default: "Create {{count}} row(s) in {{collection}}" },
        },
        update_items: {
          title: { default: "Update {{count}} row(s) in {{collection}}" },
        },
        delete_items: {
          title: { default: "Delete {{count}} row(s) from {{collection}}" },
        },
        create_order: {
          title: { default: 'Create order "{{number}}"' },
        },
        create_folder: {
          title: { default: "Create {{module}} {{type}} folder" },
        },
        create_sea_booking: {
          title: { default: 'Create sea booking "{{number}}"' },
        },
        create_air_booking: {
          title: { default: 'Create air booking "{{number}}"' },
        },
        create_quotation: {
          title: { default: 'Create quotation "{{number}}"' },
        },
        add_event: {
          title: { default: "Add an event on the {{target}}" },
        },
        set_parcels: {
          title: { default: "Replace the cargo lines of the {{target}}" },
        },
        attach_order_to_folder: {
          title: { default: "Link the order to the folder" },
        },
        detach_order_from_folder: {
          title: { default: "Unlink the order from the folder" },
        },
        share_with_entity: {
          title: { default: "Give entity {{entity_id}} access" },
        },
        revoke_share: {
          title: { default: "Revoke entity {{entity_id}}'s access" },
        },
        archive: {
          title: { default: "Cancel the {{object}}" },
        },
        set_quotation_status: {
          title: { default: "Move the quotation to {{status}}" },
        },
        transfer_to_gateway: {
          title: { default: "Send the {{object}} to a partner gateway" },
        },
        assign_containers: {
          title: { default: "Stuff cargo into containers ({{count}} row(s))" },
        },
        unassign_parcel_container: {
          title: { default: "Take a cargo line out of its container" },
        },
        activate_profile: {
          title: { default: "Switch to profile {{profile_id}}" },
        },
        create_gateway: {
          title: { default: 'Create the EDI gateway "{{code}}"' },
        },
        update_gateway: {
          title: { default: 'Update the EDI gateway "{{code}}"' },
        },
        declare_tracking: {
          title: { default: "Register the booking with carrier tracking" },
        },
        create_lta_stock: {
          title: { default: "Reserve a range of air waybill numbers" },
        },
        invite_user: {
          title: { default: "Invite {{email}}" },
        },
        create_client: {
          title: { default: 'Create the client company "{{name}}"' },
        },
      },

      shiptify: {
        create_shipment_request: {
          title: { default: 'Create shipment request "{{name}}"' },
        },
        create_shipment_request_draft: {
          title: { default: 'Create draft shipment request "{{name}}"' },
        },
        update_shipment_request: {
          title: { default: "Update shipment request" },
        },
        cancel_shipment_request: {
          title: { default: "Cancel shipment request" },
        },
        upload_shipment_request_attachment: {
          title: { default: "Upload {{count}} file(s) to shipment request" },
        },
        send_shipment_request_message: {
          title: { default: "Post message in shipment-request chat" },
        },
        confirm_shipment_pickup: {
          title: { default: "Confirm pickup on {{date}}" },
        },
        confirm_shipment_delivery: {
          title: { default: "Confirm delivery on {{date}}" },
        },
        replan_shipment_pickup: {
          title: { default: "Replan pickup to {{date}}" },
        },
        replan_shipment_delivery: {
          title: { default: "Replan delivery to {{date}}" },
        },
        upload_shipment_attachment: {
          title: { default: "Upload {{count}} file(s) to shipment" },
        },
        send_shipment_message: {
          title: { default: "Post message in shipment tracking chat" },
        },
        create_location: {
          title: { default: 'Create location "{{name}}"' },
        },
        // Galaxy (carrier-side) — same wording as the shipper variants
        // when the underlying intent matches, prefixed with "Carrier:"
        // so the user can tell the approval card apart at a glance.
        galaxy_create_carrier_shipment_request: {
          title: {
            default: 'Carrier: create shipment request "{{name}}"',
          },
        },
        galaxy_create_carrier_shipment_request_draft: {
          title: {
            default: 'Carrier: create draft shipment request "{{name}}"',
          },
        },
        galaxy_upload_shipment_request_attachment: {
          title: {
            default: "Carrier: upload {{count}} file(s) to shipment request",
          },
        },
        galaxy_send_shipment_request_message: {
          title: {
            default: "Carrier: post message in shipment-request chat",
          },
        },
        galaxy_cancel_quote_request: {
          title: { default: "Carrier: cancel quote request" },
        },
        galaxy_confirm_shipment_pickup: {
          title: { default: "Carrier: confirm pickup on {{date}}" },
        },
        galaxy_confirm_shipment_delivery: {
          title: { default: "Carrier: confirm delivery on {{date}}" },
        },
        galaxy_replan_shipment_pickup: {
          title: { default: "Carrier: replan pickup to {{date}}" },
        },
        galaxy_replan_shipment_delivery: {
          title: { default: "Carrier: replan delivery to {{date}}" },
        },
        galaxy_confirm_shipment: {
          title: { default: "Carrier: confirm shipment on {{date}}" },
        },
        galaxy_cancel_shipment: {
          title: { default: "Carrier: cancel shipment" },
        },
        galaxy_upload_shipment_attachment: {
          title: {
            default: "Carrier: upload {{count}} file(s) to shipment",
          },
        },
        galaxy_send_shipment_message: {
          title: { default: "Carrier: post message in shipment tracking chat" },
        },
        galaxy_confirm_tracking_point: {
          title: { default: "Carrier: confirm tracking point on {{date}}" },
        },
        galaxy_replan_tracking_point: {
          title: { default: "Carrier: replan tracking point to {{date}}" },
        },
        galaxy_cancel_tracking_point: {
          title: { default: "Carrier: cancel tracking point" },
        },
        galaxy_update_tracking_point_location: {
          title: { default: "Carrier: move tracking point to a new address" },
        },
      },

      front: {
        reply_to_conversation: {
          title: { default: "Reply to Front conversation" },
        },
        send_new_message: {
          title: { default: "Send new Front message to {{recipients}}" },
        },
        update_conversation: {
          title: {
            default: "Update Front conversation",
            archive: "Archive Front conversation",
            reopen: "Reopen Front conversation",
            trash: "Trash Front conversation",
            spam: "Mark Front conversation as spam",
            assign: "Assign Front conversation",
            unassign: "Unassign Front conversation",
            move: "Move Front conversation to another inbox",
          },
        },
        delete_conversation: {
          title: { default: "Delete Front conversation" },
        },
        add_conversation_tags: {
          title: { default: "Add {{count}} tag(s) to Front conversation" },
        },
        remove_conversation_tags: {
          title: {
            default: "Remove {{count}} tag(s) from Front conversation",
          },
        },
        add_conversation_comment: {
          title: { default: "Add internal note to Front conversation" },
        },
        snooze_conversation: {
          title: { default: "Snooze Front conversation until {{until}}" },
        },
        unsnooze_conversation: {
          title: { default: "Unsnooze Front conversation" },
        },
        add_conversation_followers: {
          title: {
            default: "Add {{count}} follower(s) to Front conversation",
          },
        },
        remove_conversation_followers: {
          title: {
            default: "Remove {{count}} follower(s) from Front conversation",
          },
        },
        create_contact: {
          title: {
            default: "Create Front contact",
            withName: 'Create Front contact "{{name}}"',
          },
        },
        update_contact: {
          title: { default: "Update Front contact" },
        },
        create_tag: {
          title: { default: 'Create Front tag "{{name}}"' },
        },
        update_tag: {
          title: {
            default: "Update Front tag",
            withName: 'Rename Front tag to "{{name}}"',
          },
        },
        delete_tag: {
          title: { default: "Delete Front tag" },
        },
      },

      "akanea-wms": {
        upsert_receptions: {
          title: { default: "Send {{count}} reception(s) to Akanea WMS" },
        },
        upsert_preparations: {
          title: {
            default: "Send {{count}} preparation order(s) to Akanea WMS",
          },
        },
        upsert_items: {
          title: {
            default: "Create or update {{count}} item(s) in Akanea WMS",
          },
        },
        upsert_parties: {
          title: {
            default: "Create or update {{count}} third parties in Akanea WMS",
          },
        },
        change_stock: {
          title: { default: "Modify {{count}} stock object(s) in Akanea WMS" },
        },
      },
    },
  },
};
