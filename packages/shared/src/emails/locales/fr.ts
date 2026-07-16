export default {
  base: {
    appName: "Fretik",
    footer: {
      copyright: "© {{year}} Fretik. Tous droits réservés.",
      sentBy: "Envoyé par Fretik",
    },
  },

  otp: {
    greeting: "Bonjour,",
    codeLabel: "Votre code de vérification",
    expiration: "Ce code expire dans {{minutes}} minutes.",
    ignore:
      "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail en toute sécurité.",
    emailVerification: {
      subject: "Votre code de vérification Fretik",
      intro: "Utilisez le code ci-dessous pour vérifier votre adresse e-mail.",
    },
    forgetPassword: {
      subject: "Votre code de réinitialisation de mot de passe Fretik",
      intro:
        "Utilisez le code ci-dessous pour réinitialiser votre mot de passe Fretik.",
    },
    changeEmail: {
      subject: "Confirmez votre nouvelle adresse e-mail — votre code Fretik",
      intro:
        "Utilisez le code ci-dessous pour confirmer cette adresse e-mail pour votre compte Fretik.",
    },
    signIn: {
      subject: "Votre code de connexion Fretik",
      intro: "Utilisez le code ci-dessous pour vous connecter à Fretik.",
    },
  },

  organizationInvitation: {
    subject: "Vous avez été invité à rejoindre {{organizationName}}",
    greeting: "Bonjour,",
    message:
      "{{inviterName}} vous a invité à rejoindre {{organizationName}} sur Fretik.",
    messageWithTeam:
      "{{inviterName}} vous a invité à rejoindre l'équipe {{teamName}} dans {{organizationName}} sur Fretik.",
    organizationLabel: "Organisation : {{organizationName}}",
    teamLabel: "Équipe : {{teamName}}",
    roleLabel: "Votre rôle : {{roleName}}",
    cta: "Accepter l'invitation",
    expiration: "Cette invitation expire le {{expiresAt}}.",
    ignore:
      "Si vous n'attendiez pas cette invitation, vous pouvez ignorer cet e-mail en toute sécurité.",
  },

  chatbotFinished: {
    subject: "Votre réponse Fretik est prête : {{conversationTitle}}",
    greetingNamed: "Bonjour {{name}},",
    greetingAnonymous: "Bonjour,",
    intro:
      'Le chatbot Fretik a répondu dans votre conversation "{{conversationTitle}}" :',
    cta: "Ouvrir la conversation",
    replyHeader: "Assistant Fretik",
    untitledConversation: "votre conversation",
    oversizedAttachments:
      "Certains fichiers générés au cours de ce tour étaient trop volumineux pour être joints (plus de 20 Mo au total). Ouvrez la conversation pour les télécharger.",
  },

  chatbotMention: {
    subject: "{{mentionedBy}} vous a mentionné dans une conversation Fretik",
    greetingNamed: "Bonjour {{name}},",
    greetingAnonymous: "Bonjour,",
    intro:
      '{{mentionedBy}} vous a mentionné dans la conversation "{{conversationTitle}}".',
    cta: "Ouvrir la conversation",
    untitledConversation: "une conversation",
    someone: "Un collègue",
  },

  chatbotFinishedAwaitingAnswers: {
    subject:
      "Action requise dans votre conversation Fretik : {{conversationTitle}}",
    greetingNamed: "Bonjour {{name}},",
    greetingAnonymous: "Bonjour,",
    intro:
      'Le chatbot Fretik attend votre réponse avant de pouvoir continuer la conversation "{{conversationTitle}}". Veuillez répondre à la ou aux questions ci-dessous pour reprendre.',
    cta: "Ouvrir la conversation et répondre",
    questionsHeader: "Questions en attente de votre réponse",
    multiSelectHint: "Plusieurs réponses possibles.",
    freeTextHint:
      "Vous pouvez aussi saisir une réponse libre si aucune des options ne convient.",
    untitledConversation: "votre conversation",
  },

  chatbotApprovalPending: {
    subject:
      "Validation requise dans votre conversation Fretik : {{conversationTitle}}",
    greetingNamed: "Bonjour {{name}},",
    greetingAnonymous: "Bonjour,",
    intro:
      'Le chatbot Fretik a préparé un plan dans votre conversation "{{conversationTitle}}" qui nécessite votre validation avant de pouvoir être exécuté.',
    cta: "Examiner et approuver",
    untitledConversation: "votre conversation",
  },

  workflowRunFinished: {
    subject: "Workflow terminé : {{workflowName}}",
    greetingNamed: "Bonjour {{name}},",
    greetingAnonymous: "Bonjour,",
    intro:
      'Le workflow "{{workflowName}}" a terminé une exécution. Le résultat est ci-dessous ; les fichiers produits sont en pièces jointes.',
    cta: "Ouvrir l'exécution",
    resultHeader: "Résultat de l'exécution",
    oversizedAttachments:
      "Certains fichiers produits par cette exécution étaient trop volumineux pour être joints (plus de 20 Mo au total). Ouvrez l'exécution pour les télécharger.",
  },

  workflowRunFailed: {
    subject: "Échec d'une exécution du workflow : {{workflowName}}",
    greetingNamed: "Bonjour {{name}},",
    greetingAnonymous: "Bonjour,",
    intro: 'Une exécution du workflow "{{workflowName}}" a échoué.',
    cta: "Ouvrir l'exécution",
    errorHeader: "Erreur",
    resultHeader: "Dernière sortie",
    unknownError:
      "L'exécution s'est arrêtée sans rapporter d'erreur détaillée.",
  },

  workflowRunApproval: {
    subject: "Validation requise : {{workflowName}}",
    greetingNamed: "Bonjour {{name}},",
    greetingAnonymous: "Bonjour,",
    intro:
      'Le workflow "{{workflowName}}" a mis une exécution en pause — elle nécessite une validation avant de pouvoir continuer.',
    cta: "Examiner et reprendre l'exécution",
    questionsHeader: "Questions en attente de réponse",
    multiSelectHint: "Plusieurs réponses possibles.",
    genericDetail: "Ouvrez l'exécution pour examiner l'action en attente.",
  },
};
