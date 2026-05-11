const scwSecretKey = process.env.SCW_SECRET_KEY;
const scwProjectId = process.env.SCW_PROJECT_ID;
const scwEmailRegion = process.env.SCW_EMAIL_REGION;
const emailFromName = process.env.EMAIL_FROM_NAME;
const emailFromAddress = process.env.EMAIL_FROM_ADDRESS;

if (
  !scwSecretKey ||
  !scwProjectId ||
  !scwEmailRegion ||
  !emailFromName ||
  !emailFromAddress
) {
  throw "Missing email env vars";
}

const apiUrl = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${scwEmailRegion}/emails`;

interface EmailRecipient {
  name?: string;
  email: string;
}

interface EmailAttachment {
  name: string;
  type: string;
  content: string;
}

interface SendEmailOptions {
  to: EmailRecipient | EmailRecipient[];
  subject: string;
  html: string;
  text?: string;
  cc?: EmailRecipient[];
  bcc?: EmailRecipient[];
  replyTo?: string;
  attachments?: EmailAttachment[];
}

/**
 * Send an email via Scaleway Transactional Email API.
 * Accepts a single recipient or an array of recipients.
 * Attachments content must be base64 encoded.
 */
export const sendEmail = async (options: SendEmailOptions): Promise<void> => {
  const recipients = Array.isArray(options.to) ? options.to : [options.to];

  const additionalHeaders: { key: string; value: string }[] = [];
  if (options.replyTo) {
    additionalHeaders.push({ key: "Reply-To", value: options.replyTo });
  }

  const payload = {
    from: {
      name: emailFromName,
      email: emailFromAddress,
    },
    to: recipients,
    subject: options.subject,
    project_id: scwProjectId,
    html: options.html,
    ...(options.text && { text: options.text }),
    ...(options.cc && options.cc.length > 0 && { cc: options.cc }),
    ...(options.bcc && options.bcc.length > 0 && { bcc: options.bcc }),
    ...(additionalHeaders.length > 0 && {
      additional_headers: additionalHeaders,
    }),
    ...(options.attachments &&
      options.attachments.length > 0 && { attachments: options.attachments }),
  };

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": scwSecretKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error("[Email] Scaleway API error:", response.status, errorBody);
    throw new Error(
      `Email sending failed: ${response.status} ${response.statusText}`,
    );
  }
};
