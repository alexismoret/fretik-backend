export default {
  base: {
    appName: "Fretik",
    footer: {
      copyright: "© {{year}} Fretik. All rights reserved.",
      sentBy: "Sent by Fretik",
    },
  },

  otp: {
    greeting: "Hello,",
    codeLabel: "Your verification code",
    expiration: "This code expires in {{minutes}} minutes.",
    ignore: "If you didn't request this, you can safely ignore this email.",
    emailVerification: {
      subject: "Your Fretik verification code",
      intro: "Use the code below to verify your email address.",
    },
    forgetPassword: {
      subject: "Your Fretik password reset code",
      intro: "Use the code below to reset your Fretik password.",
    },
    changeEmail: {
      subject: "Confirm your new email — your Fretik code",
      intro:
        "Use the code below to confirm this email address for your Fretik account.",
    },
    signIn: {
      subject: "Your Fretik sign-in code",
      intro: "Use the code below to sign in to Fretik.",
    },
  },

  organizationInvitation: {
    subject: "You've been invited to join {{organizationName}}",
    greeting: "Hello,",
    message:
      "{{inviterName}} has invited you to join {{organizationName}} on Fretik.",
    messageWithTeam:
      "{{inviterName}} has invited you to join the team {{teamName}} in {{organizationName}} on Fretik.",
    organizationLabel: "Organization: {{organizationName}}",
    teamLabel: "Team: {{teamName}}",
    roleLabel: "Your role: {{roleName}}",
    cta: "Accept Invitation",
    expiration: "This invitation expires on {{expiresAt}}.",
    ignore:
      "If you didn't expect this invitation, you can safely ignore this email.",
  },

  chatbotFinished: {
    subject: "Your Fretik reply is ready: {{conversationTitle}}",
    greetingNamed: "Hello {{name}},",
    greetingAnonymous: "Hello,",
    intro:
      'The Fretik chatbot has replied in your conversation "{{conversationTitle}}":',
    cta: "Open the conversation",
    replyHeader: "Fretik Assistant",
    untitledConversation: "your conversation",
    oversizedAttachments:
      "Some files generated during this turn were too large to attach (>20 MB total). Open the conversation to download them.",
  },

  chatbotMention: {
    subject: "{{mentionedBy}} mentioned you in a Fretik conversation",
    greetingNamed: "Hello {{name}},",
    greetingAnonymous: "Hello,",
    intro:
      '{{mentionedBy}} mentioned you in the conversation "{{conversationTitle}}".',
    cta: "Open the conversation",
    untitledConversation: "a conversation",
  },

  chatbotFinishedAwaitingAnswers: {
    subject: "Action needed in your Fretik conversation: {{conversationTitle}}",
    greetingNamed: "Hello {{name}},",
    greetingAnonymous: "Hello,",
    intro:
      'The Fretik chatbot is waiting for your input before it can continue the conversation "{{conversationTitle}}". Please answer the question(s) below to resume.',
    cta: "Open the conversation and answer",
    questionsHeader: "Questions awaiting your answer",
    multiSelectHint: "Multiple answers possible.",
    freeTextHint:
      "You can also type a free-text answer if none of the options fit.",
    untitledConversation: "your conversation",
  },

  chatbotApprovalPending: {
    subject:
      "Approval required in your Fretik conversation: {{conversationTitle}}",
    greetingNamed: "Hello {{name}},",
    greetingAnonymous: "Hello,",
    intro:
      'The Fretik chatbot prepared a plan in your conversation "{{conversationTitle}}" that needs your review before it can be executed.',
    cta: "Review and approve",
    untitledConversation: "your conversation",
  },
};
