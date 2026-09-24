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
      subject: "Votre code Fretik pour confirmer votre nouvelle adresse e-mail",
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
    subjectExistingMember: "Vous avez reçu l'accès à l'équipe {{teamName}}",
    messageExistingMember:
      "{{inviterName}} vous a invité dans l'équipe {{teamName}} de {{organizationName}}. En acceptant, elle s'ajoute aux espaces auxquels vous avez déjà accès. Vos équipes actuelles et votre rôle restent inchangés.",
    ctaExistingMember: "Rejoindre l'équipe",
    organizationLabel: "Organisation : {{organizationName}}",
    teamLabel: "Équipe : {{teamName}}",
    roleLabel: "Votre rôle : {{roleName}}",
    cta: "Accepter l'invitation",
    expiration: "Cette invitation expire le {{expiresAt}}.",
    ignore:
      "Si vous n'attendiez pas cette invitation, vous pouvez ignorer cet e-mail en toute sécurité.",
    subjectItem: "{{inviterName}} a partagé « {{itemName}} » avec vous",
    messageItem: {
      view: "{{inviterName}} vous invite à consulter « {{itemName}} » dans {{organizationName}} sur Fretik.",
      use: "{{inviterName}} vous invite à utiliser « {{itemName}} » dans {{organizationName}} sur Fretik.",
      edit: "{{inviterName}} vous invite à modifier « {{itemName}} » dans {{organizationName}} sur Fretik.",
      full: "{{inviterName}} vous donne un accès complet à « {{itemName}} » dans {{organizationName}} sur Fretik.",
    },
    itemLabel: "Partagé avec vous : {{itemName}}",
    guestLabel:
      "En tant qu'invité, vous ne voyez que ce qui est partagé avec vous.",
    ctaItem: "Accepter et ouvrir",
  },

  sharedWithGuest: {
    subject: "{{sharerName}} a partagé « {{resourceName}} » avec vous",
    greeting: "Bonjour {{name}},",
    intro: {
      view: "{{sharerName}} a partagé « {{resourceName}} » avec vous dans {{organizationName}} : vous pouvez le consulter.",
      use: "{{sharerName}} a partagé « {{resourceName}} » avec vous dans {{organizationName}} : vous pouvez l'utiliser.",
      edit: "{{sharerName}} a partagé « {{resourceName}} » avec vous dans {{organizationName}} : vous pouvez le modifier.",
      full: "{{sharerName}} vous a donné un accès complet à « {{resourceName}} » dans {{organizationName}}.",
    },
    until: "Votre accès dure jusqu'au {{date}}.",
    cta: "L'ouvrir",
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
      'Le workflow "{{workflowName}}" a mis une exécution en pause. Elle nécessite une validation avant de pouvoir continuer.',
    cta: "Examiner et reprendre l'exécution",
    questionsHeader: "Questions en attente de réponse",
    multiSelectHint: "Plusieurs réponses possibles.",
    genericDetail: "Ouvrez l'exécution pour examiner l'action en attente.",
  },

  securityNotice: {
    greetingNamed: "Bonjour {{name}},",
    greetingAnonymous: "Bonjour,",
    passkeyAdded: {
      subject: "Une clé d'accès a été ajoutée à votre compte Fretik",
      intro:
        "Une nouvelle clé d'accès a été ajoutée à votre compte Fretik. Elle permet désormais de se connecter sans mot de passe.",
    },
    passkeyRemoved: {
      subject: "Une clé d'accès a été supprimée de votre compte Fretik",
      intro:
        "Une clé d'accès a été supprimée de votre compte Fretik. Elle ne permet plus de se connecter.",
    },
    passkeyLabel: "Clé d'accès : {{name}}",
    defaultPasskeyName: "Clé d'accès",
    dateLabel: "Date : {{date}}",
    deviceLabel: "Appareil : {{device}}",
    cta: "Vérifier vos paramètres de sécurité",
    notYou:
      "Si vous n'êtes pas à l'origine de cette action, changez votre mot de passe immédiatement et supprimez toute clé d'accès que vous ne reconnaissez pas.",
  },

  accessRequest: {
    subject: "{{requesterName}} demande l'accès à {{resourceName}}",
    greeting: "Bonjour {{name}},",
    intro: {
      view: "{{requesterName}} demande à consulter « {{resourceName}} ».",
      use: "{{requesterName}} demande à utiliser « {{resourceName}} ».",
      edit: "{{requesterName}} demande à modifier « {{resourceName}} ».",
      full: "{{requesterName}} demande un accès complet à « {{resourceName}} ».",
    },
    messageLabel: "Son message",
    cta: "Voir la demande",
    footnote:
      "Vous recevez cet e-mail parce que vous avez un accès complet à cet élément : seules les personnes ayant un accès complet peuvent répondre.",
  },

  accessRequestDecided: {
    greeting: "Bonjour {{name}},",
    approved: {
      subject: "Vous avez désormais accès à {{resourceName}}",
      intro: {
        view: "{{deciderName}} vous permet désormais de consulter « {{resourceName}} ».",
        use: "{{deciderName}} vous permet désormais d'utiliser « {{resourceName}} ».",
        edit: "{{deciderName}} vous permet désormais de modifier « {{resourceName}} ».",
        full: "{{deciderName}} vous a donné un accès complet à « {{resourceName}} ».",
      },
      cta: "L'ouvrir",
    },
    denied: {
      subject: "Votre demande pour {{resourceName}} a été refusée",
      intro:
        "{{deciderName}} a refusé votre demande d'accès supplémentaire à « {{resourceName}} ».",
    },
  },
};
